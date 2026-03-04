import path from "path";
import fs from "fs";
import glob from "fast-glob";
import {
  parse,
  buildSchema,
  GraphQLObjectType,
  FragmentDefinitionNode,
} from "graphql";
import { Project, SyntaxKind } from "ts-morph";
import {
  extractFragmentName,
  getFakerMockForScalar,
  getFieldFragmentMap,
  getFragmentTypeCondition,
  getTopLevelFragmentSpreads,
  handleIdField,
  isEnum,
  isListTypeDeep,
  isScalar,
  markFactoryAsGenerated,
  normalizeModulePath,
  resolveEnumAccess,
  resolveModule,
  shouldRegenerateFactory,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  toRelativeImport,
  unwrapType,
  updateManualFactory,
} from "../lib/helpers";

// Constants
const SCHEMA_PATH = path.resolve("schema.graphql");
const IDS_PATH = path.resolve("src/gql/ids.ts");

export const generateFactory = async (fragmentPath: string) => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, "utf-8");
  const schema = buildSchema(schemaContent);
  const idsProject = new Project();
  const idsSource = idsProject.addSourceFileAtPath(IDS_PATH);
  const idsObject = idsSource
    .getVariableDeclarationOrThrow("ids")
    .getInitializerIfKindOrThrow(SyntaxKind.ObjectLiteralExpression);

  const fragmentFiles = fragmentPath
    ? [fragmentPath]
    : glob.sync("src/**/*.fragment.gql");

  for (const filePath of fragmentFiles) {
    const content = fs.readFileSync(filePath, "utf-8");
    const fragmentAst = parse(content);
    const fragment = fragmentAst.definitions.find(
      (d): d is FragmentDefinitionNode => d.kind === "FragmentDefinition",
    );
    if (!fragment) continue;

    const type = schema.getType(
      fragment.typeCondition.name.value,
    ) as GraphQLObjectType;
    if (!type) continue;

    const fragmentName = fragment.name.value;
    const typeName = `${fragmentName}Fragment`;
    const factoryName = `createMock${fragmentName}`;
    const defaultObjectName = `default${fragmentName}`;
    const fragmentDir = path.dirname(filePath);
    const fragmentBase = toKebabCase(fragmentName);
    const factoryFilePath = path.join(
      fragmentDir,
      `${fragmentBase}.factory.ts`,
    );
    const idsRelativePath = toRelativeImport(fragmentDir, IDS_PATH);

    // Improved Import manager with path normalization and symbol tracking
    class ImportManager {
      private namedImports = new Map<string, Set<string>>(); // module -> symbols
      private literalImports = new Set<string>(); // full import statements
      private symbolToModule = new Map<string, string>(); // symbol -> module (for conflict resolution)
      private baseDir: string;
      
      constructor(baseDir: string, existingFactoryPath?: string) {
        this.baseDir = baseDir;
        if (existingFactoryPath && fs.existsSync(existingFactoryPath)) {
          this.seedFromExistingFile(existingFactoryPath);
        }
      }
      
      private seedFromExistingFile(filePath: string): void {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('import ')) continue;
          
          // Parse named imports: import { A, B } from "./path";
          const namedMatch = trimmed.match(/^import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["'];?$/);
          if (namedMatch) {
            const [, importsStr, rawPath] = namedMatch;
            const resolvedPath = resolveModule(this.baseDir, rawPath);
            const symbols = importsStr.split(',').map(s => s.trim()).filter(Boolean);
            
            for (const symbol of symbols) {
              this.addNamedImport(resolvedPath, symbol);
            }
            continue;
          }
          
          // Parse literal imports - store as-is for now
          this.literalImports.add(trimmed);
        }
      }

      addLiteralImport(importStatement: string): void {
        this.literalImports.add(importStatement);
      }

      addNamedImport(modulePath: string, symbol: string): void {
        const resolvedPath = resolveModule(this.baseDir, modulePath);
        const normalizedPath = normalizeModulePath(resolvedPath);
        
        // Guard: skip if symbol is already mapped to the same normalized module
        const existingModule = this.symbolToModule.get(symbol);
        if (existingModule === normalizedPath) {
          return; // Already mapped correctly, skip
        }
        
        // Check for symbol conflicts
        if (existingModule && existingModule !== normalizedPath) {
          // Prefer local relative paths over distant ones
          const currentDepth = normalizedPath.split('/').length;
          const existingDepth = existingModule.split('/').length;
          
          if (currentDepth < existingDepth || 
              (normalizedPath.startsWith('./') && !existingModule.startsWith('./'))) {
            // Use the new path
            this.removeSymbolFromModule(existingModule, symbol);
          } else {
            // Keep the existing path, skip this one
            return;
          }
        }
        
        // Track symbol to module mapping
        this.symbolToModule.set(symbol, normalizedPath);
        
        // Add to named imports
        if (!this.namedImports.has(normalizedPath)) {
          this.namedImports.set(normalizedPath, new Set());
        }
        this.namedImports.get(normalizedPath)!.add(symbol);
      }
      
      private removeSymbolFromModule(modulePath: string, symbol: string): void {
        const symbols = this.namedImports.get(modulePath);
        if (symbols) {
          symbols.delete(symbol);
          if (symbols.size === 0) {
            this.namedImports.delete(modulePath);
          }
        }
      }

      buildMergedImports(): string[] {
        const imports: string[] = [];
        
        // Add literal imports first (sorted)
        imports.push(...Array.from(this.literalImports).sort());
        
        // Add named imports - one line per module
        const sortedModules = Array.from(this.namedImports.keys()).sort();
        for (const modulePath of sortedModules) {
          const symbols = this.namedImports.get(modulePath)!;
          if (symbols.size > 0) {
            const sortedSymbols = Array.from(symbols).sort().join(', ');
            imports.push(`import { ${sortedSymbols} } from "${modulePath}";`);
          }
        }
        
        return imports;
      }
    }

    // Build field definitions first
    const importManager = new ImportManager(fragmentDir, factoryFilePath);
    const imports = [
      `import { ${typeName} } from "./${fragmentBase}.fragment.generated";`,
    ];
    const fields: string[] = [];
    const fieldDefinitions: Record<string, string> = {};

    const fieldToFragmentMap = getFieldFragmentMap(content);
    const topLevelSpreads = getTopLevelFragmentSpreads(content);

    // Process all selections including inline fragments and fragment spreads
    const processSelections = async (selections: any[], level: number = 0): Promise<void> => {
      for (const selection of selections) {
        if (selection.kind === "Field") {
          const fieldName = selection.alias?.value ?? selection.name.value;
          const gqlFieldName = selection.name.value;
          const gqlField = type.getFields()[gqlFieldName];
          if (!gqlField) {
            // Field not found in schema, preserve existing if it exists
            fieldDefinitions[fieldName] = "__KEEP_EXISTING__";
            continue;
          }
          const baseType = unwrapType(gqlField.type);

          if (gqlFieldName === "id") {
            handleIdField(
              type,
              idsObject,
              baseType,
              idsRelativePath,
              fields,
              imports,
            );
            // Add ids import to import manager
            const idsModule = resolveModule(fragmentDir, IDS_PATH);
            importManager.addNamedImport(idsModule, "ids");
            fieldDefinitions[fieldName] = `ids.${toCamelCase(type.name)}[0]`;
            continue;
          }

          if (isScalar(baseType)) {
            const mockValue = getFakerMockForScalar(baseType.name, gqlFieldName);
            const line = isListTypeDeep(gqlField.type)
              ? `  ${fieldName}: [${mockValue}],`
              : `  ${fieldName}: ${mockValue},`;
            fields.push(line);
            fieldDefinitions[fieldName] = isListTypeDeep(gqlField.type)
              ? `[${mockValue}]`
              : mockValue;
            continue;
          }

          if (isEnum(baseType)) {
            const enumAccess = resolveEnumAccess(baseType.name, fragmentDir);
            if (enumAccess.import) {
              // Parse enum import to extract symbol and path
              const enumMatch = enumAccess.import.match(/^import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["'];?$/);
              if (enumMatch) {
                const [, symbol, rawModulePath] = enumMatch;
                importManager.addNamedImport(rawModulePath, symbol.trim());
              } else {
                importManager.addLiteralImport(enumAccess.import);
              }
            }
            fields.push(`  ${fieldName}: ${enumAccess.value},`);
            fieldDefinitions[fieldName] = enumAccess.value;
            continue;
          }

          // Nested Fragment Handling - improved resolution with type checking
          let fragmentToSearch: string | null = null;
          let nestedFragmentPath: string | null = null;
          
          // First try the fieldToFragmentMap hint
          if (fieldToFragmentMap[gqlFieldName]) {
            const hintedFragmentName = toPascalCase(fieldToFragmentMap[gqlFieldName]);
            const hintedPath = glob.sync(
              `src/**/*/${toKebabCase(hintedFragmentName)}.fragment.gql`,
            )[0];
            
            // Validate that the fragment's type condition matches the field's base type
            if (hintedPath) {
              try {
                const fragmentTypeCondition = getFragmentTypeCondition(hintedPath);
                if (fragmentTypeCondition === baseType.name) {
                  fragmentToSearch = hintedFragmentName;
                  nestedFragmentPath = hintedPath;
                }
              } catch {
                // Fragment validation failed, fall through to baseType fallback
              }
            }
          }
          
          // Fall back to baseType.name if hint failed
          if (!nestedFragmentPath) {
            fragmentToSearch = toPascalCase(baseType.name);
            nestedFragmentPath = glob.sync(
              `src/**/*/${toKebabCase(fragmentToSearch)}.fragment.gql`,
            )[0];
          }
          
          if (!nestedFragmentPath) {
            // Fragment path couldn't be resolved, preserve existing field
            fieldDefinitions[fieldName] = "__KEEP_EXISTING__";
            continue;
          }

          const nestedFragmentName = extractFragmentName(nestedFragmentPath);
          const nestedFactoryName = `createMock${toPascalCase(nestedFragmentName)}`;
          const nestedFactoryPath = nestedFragmentPath.replace(
            ".fragment.gql",
            ".factory.ts",
          );

          await generateFactory(nestedFragmentPath);

          importManager.addNamedImport(nestedFactoryPath, nestedFactoryName);
          const factoryCall = isListTypeDeep(gqlField.type)
            ? `[${nestedFactoryName}()]`
            : `${nestedFactoryName}()`;
          fields.push(`  ${fieldName}: ${factoryCall},`);
          fieldDefinitions[fieldName] = factoryCall;
        } else if (selection.kind === "InlineFragment") {
          // Recurse into inline fragment selections
          await processSelections(selection.selectionSet.selections, level + 1);
        } else if (selection.kind === "FragmentSpread") {
          // Collect fragment spreads at any nesting level
          const spreadName = selection.name.value;
          topLevelSpreads.add(spreadName);
        }
      }
    };

    // Process all selections starting from the fragment's selection set
    await processSelections(fragment.selectionSet.selections);

    for (const spread of topLevelSpreads) {
      const spreadFactory = `createMock${spread}`;
      const match = glob.sync(
        `src/gql/**/${toKebabCase(spread)}.factory.ts`,
      )[0];
      if (!match) continue;
      importManager.addNamedImport(match, spreadFactory);
      fields.unshift(`  ...${spreadFactory}(),`);
    }

    fields.push(`  __typename: "${type.name}",`);
    fieldDefinitions["__typename"] = `"${type.name}"`;

    // Check if factory needs regeneration or update
    const { shouldRegenerate, reason, requiresUpdate, diff } =
      shouldRegenerateFactory(
        filePath,
        factoryFilePath,
        schemaContent,
        fieldDefinitions,
      );

    if (!shouldRegenerate) {
      // Don't log anything when no changes
      continue;
    }

    // Handle manual factory updates
    if (requiresUpdate && diff) {
      const wasUpdated = updateManualFactory(
        factoryFilePath,
        diff,
        fieldDefinitions,
        { mergedImports: importManager.buildMergedImports() }
      );
      if (wasUpdated) {
        markFactoryAsGenerated(filePath, factoryFilePath, schemaContent);
      }
      continue;
    }

    const fileContent = [
      ...imports,
      ...importManager.buildMergedImports(),
      "",
      `const ${defaultObjectName}: ${typeName} = {`,
      ...fields,
      `};`,
      "",
      `export const ${factoryName} = (overwrites: Partial<${typeName}> = {}): ${typeName} => ({`,
      `  ...${defaultObjectName},`,
      `  ...overwrites,`,
      `});`,
    ].join("\n");

    const isNewFile = !fs.existsSync(factoryFilePath);
    fs.writeFileSync(factoryFilePath, fileContent);
    markFactoryAsGenerated(filePath, factoryFilePath, schemaContent);

    if (isNewFile) {
      console.log(`Created ${factoryName}`);
    } else {
      console.log(`Regenerated ${factoryName}`);
    }
  }

  idsSource.saveSync();
};
