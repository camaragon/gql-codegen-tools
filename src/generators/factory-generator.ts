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
  getTopLevelFragmentSpreads,
  handleIdField,
  isEnum,
  isListTypeDeep,
  isScalar,
  markFactoryAsGenerated,
  resolveEnumAccess,
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
    : glob.sync("src/**/*/*.fragment.gql");

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

    // Build field definitions first
    const imports = [
      `import { ${typeName} } from "./${fragmentBase}.fragment.generated";`,
    ];
    const nestedImports: string[] = [];
    const fields: string[] = [];
    const fieldDefinitions: Record<string, string> = {};

    const fieldToFragmentMap = getFieldFragmentMap(content);
    const topLevelSpreads = getTopLevelFragmentSpreads(content);

    for (const selection of fragment.selectionSet.selections) {
      if (selection.kind !== "Field") continue;

      const fieldName = selection.name.value;
      const gqlField = type.getFields()[fieldName];
      const baseType = unwrapType(gqlField.type);

      if (fieldName === "id") {
        handleIdField(
          type,
          idsObject,
          baseType,
          idsRelativePath,
          fields,
          imports,
        );
        fieldDefinitions[fieldName] = `ids.${toCamelCase(type.name)}[0]`;
        continue;
      }

      if (isScalar(baseType)) {
        const mockValue = getFakerMockForScalar(baseType.name, fieldName);
        const line = isListTypeDeep(gqlField.type)
          ? `  ${fieldName}: [${mockValue}],`
          : `  ${fieldName}: ${mockValue},`;
        fields.push(line);
        fieldDefinitions[fieldName] = isListTypeDeep(gqlField.type) ? `[${mockValue}]` : mockValue;
        continue;
      }

      if (isEnum(baseType)) {
        const enumAccess = resolveEnumAccess(baseType.name, fragmentDir);
        if (enumAccess.import) nestedImports.push(enumAccess.import);
        fields.push(`  ${fieldName}: ${enumAccess.value},`);
        fieldDefinitions[fieldName] = enumAccess.value;
        continue;
      }

      // Nested Fragment Handling
      const fragmentToSearch = toPascalCase(
        fieldToFragmentMap[fieldName] || baseType.name,
      );
      const nestedFragmentPath = glob.sync(
        `src/**/*/${toKebabCase(fragmentToSearch)}.fragment.gql`,
      )[0];
      if (!nestedFragmentPath) continue;

      const nestedFragmentName = extractFragmentName(nestedFragmentPath);
      const nestedFactoryName = `createMock${toPascalCase(nestedFragmentName)}`;
      const nestedFactoryPath = nestedFragmentPath.replace(
        ".fragment.gql",
        ".factory.ts",
      );

      if (!fs.existsSync(nestedFactoryPath)) {
        await generateFactory(nestedFragmentPath);
      }

      const relPath = toRelativeImport(fragmentDir, nestedFactoryPath);
      nestedImports.push(`import { ${nestedFactoryName} } from "${relPath}";`);
      const factoryCall = isListTypeDeep(gqlField.type)
        ? `[${nestedFactoryName}()]`
        : `${nestedFactoryName}()`;
      fields.push(`  ${fieldName}: ${factoryCall},`);
      fieldDefinitions[fieldName] = factoryCall;
    }

    for (const spread of topLevelSpreads) {
      const spreadFactory = `createMock${spread}`;
      const match = glob.sync(
        `src/gql/**/${toKebabCase(spread)}.factory.ts`,
      )[0];
      if (!match) continue;
      const relPath = toRelativeImport(fragmentDir, match);
      nestedImports.push(`import { ${spreadFactory} } from "${relPath}";`);
      fields.unshift(`  ...${spreadFactory}(),`);
    }

    fields.push(`  __typename: "${type.name}",`);
    fieldDefinitions["__typename"] = `"${type.name}"`;

    // Check if factory needs regeneration or update
    const { shouldRegenerate, reason, requiresUpdate, diff } = shouldRegenerateFactory(
      filePath, 
      factoryFilePath, 
      schemaContent, 
      fieldDefinitions
    );
    
    if (!shouldRegenerate) {
      // Don't log anything when no changes
      continue;
    }
    
    // Handle manual factory updates
    if (requiresUpdate && diff) {
      const wasUpdated = updateManualFactory(factoryFilePath, diff, fieldDefinitions);
      if (wasUpdated) {
        markFactoryAsGenerated(filePath, factoryFilePath, schemaContent);
      }
      continue;
    }

    const fileContent = [
      ...imports,
      ...nestedImports,
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

