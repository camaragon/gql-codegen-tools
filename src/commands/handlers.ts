import path from "path";
import fs from "fs";
import glob from "fast-glob";
import {
  parse,
  Kind,
  FragmentSpreadNode,
  FieldNode,
  SelectionNode,
  isNonNullType,
  GraphQLList,
  buildSchema,
  isObjectType,
  getNamedType,
} from "graphql";
import {
  markHandlerAsGenerated,
  resolveStorybookTestImport,
  shouldRegenerateHandler,
  toKebabCase,
  toPascalCase,
  toRelativeImport,
} from "../lib/helpers";

// Recursively build mock response data from a selection set, using schema type info
function buildMockResponse(
  selections: readonly SelectionNode[],
  parentType: import("graphql").GraphQLObjectType,
  schema: import("graphql").GraphQLSchema,
  imports: Set<string>,
  dir: string,
  indent: string = "      ",
): string {
  const lines: string[] = [];

  for (const sel of selections) {
    if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const frag = sel as FragmentSpreadNode;
      const fragName = frag.name.value;
      const factoryName = `createMock${fragName}`;
      const fragFile = glob.sync(
        `src/**/${toKebabCase(fragName)}.factory.ts`,
      )[0];
      if (fragFile) {
        const relImport = toRelativeImport(dir, fragFile);
        imports.add(`import { ${factoryName} } from "${relImport}";`);
        // For fragment spreads at top level, the factory call is the field value
        // (handled by the parent field that contains this spread)
      }
    } else if (sel.kind === Kind.FIELD) {
      const field = sel as FieldNode;
      const name = field.name.value;
      const fieldDef = parentType.getFields()[name];
      if (!fieldDef) continue;

      const returnType = fieldDef.type;

      // Check if it's a list (unwrapping NonNulls)
      let unwrapped = returnType;
      while (isNonNullType(unwrapped)) unwrapped = unwrapped.ofType;
      const isList = unwrapped instanceof GraphQLList;

      const namedType = getNamedType(returnType);
      if (!namedType) continue;

      if (field.selectionSet) {
        // Check if the selection set contains only a fragment spread — use factory directly
        const spreadOnly = field.selectionSet.selections.length === 1 &&
          field.selectionSet.selections[0].kind === Kind.FRAGMENT_SPREAD;

        if (spreadOnly) {
          const frag = field.selectionSet.selections[0] as FragmentSpreadNode;
          const fragName = frag.name.value;
          const factoryName = `createMock${fragName}`;
          const fragFile = glob.sync(
            `src/**/${toKebabCase(fragName)}.factory.ts`,
          )[0];
          if (fragFile) {
            const relImport = toRelativeImport(dir, fragFile);
            imports.add(`import { ${factoryName} } from "${relImport}";`);
            const call = isList ? `[${factoryName}()]` : `${factoryName}()`;
            lines.push(`${indent}${name}: ${call},`);
          }
        } else if (isObjectType(namedType)) {
          // Nested object with mixed selections — build inline object
          const innerIndent = indent + "  ";
          const innerContent = buildMockResponse(
            field.selectionSet.selections,
            namedType,
            schema,
            imports,
            dir,
            innerIndent,
          );
          if (isList) {
            lines.push(`${indent}${name}: [{`);
          } else {
            lines.push(`${indent}${name}: {`);
          }
          lines.push(innerContent);
          lines.push(`${innerIndent}__typename: "${namedType.name}",`);
          if (isList) {
            lines.push(`${indent}}],`);
          } else {
            lines.push(`${indent}},`);
          }
        }
      } else {
        // Scalar field — shouldn't typically appear in handler mock data
        // but handle gracefully
        lines.push(`${indent}${name}: "mock-${name}",`);
      }
    }
  }

  return lines.join("\n");
}

export const handlersCommand = async () => {
  const schemaContent = fs.readFileSync("schema.graphql", "utf-8");
  const schema = buildSchema(schemaContent);
  const storybookImport = resolveStorybookTestImport();
  const gqlFiles = glob.sync("src/**/*.{query,mutation}.gql");
  if (gqlFiles.length === 0) {
    console.warn("No .{query,mutation}.gql files found. Nothing to generate.");
    return;
  }

  for (const gqlPath of gqlFiles) {
    const content = fs.readFileSync(gqlPath, "utf-8");
    const ast = parse(content);
    const operation = ast.definitions.find(
      (d) => d.kind === "OperationDefinition",
    );
    if (!operation || operation.kind !== "OperationDefinition") continue;
    if (!operation.name) continue;
    const opName = operation.name.value;
    const opType = operation.operation; // 'query' or 'mutation'
    const dir = path.dirname(gqlPath);
    const base = toKebabCase(opName.replace(/(Query|Mutation)$/, ""));
    const handlerName = opName.charAt(0).toLowerCase() + opName.slice(1);
    const spyName = `${handlerName}Spy`;
    const mockHandlerName = `mock${toPascalCase(opName)}${toPascalCase(opType)}`;
    const mockHandlerFile = glob
      .sync(`${dir}/*.query.generated.ts`)
      .concat(glob.sync(`${dir}/*.mutation.generated.ts`))[0];
    const relMockHandlerImport = mockHandlerFile
      ? toRelativeImport(dir, mockHandlerFile)
      : null;
    // Build imports
    const imports = new Set<string>();

    // Get the root query/mutation type from the schema
    const rootType = opType === "query"
      ? schema.getQueryType()
      : schema.getMutationType();

    // Build mock response recursively from the operation's selection set
    let mockData = "";
    if (rootType && operation.selectionSet) {
      mockData = buildMockResponse(
        operation.selectionSet.selections,
        rootType,
        schema,
        imports,
        dir,
      );
    }
    // Compose handler file
    let handlerContent = `import { HttpResponse } from "msw";
import { fn } from "${storybookImport}";
${Array.from(imports).join("\n")}
${relMockHandlerImport ? `import { ${mockHandlerName} } from "${relMockHandlerImport}";` : ""}

export const ${spyName} = fn();

export const ${handlerName} = ${mockHandlerName}(({ variables }) => {
  ${spyName}(variables);
  return HttpResponse.json({
    data: {
${mockData}
    },
  });
});

export default ${handlerName};
`;
    const baseFileName = path
      .basename(gqlPath)
      .replace(/\.(query|mutation)\.gql$/, "");
    const handlerPath = path.join(dir, `${baseFileName}.handler.ts`);
    
    // Check if handler needs regeneration
    const { shouldRegenerate, reason } = shouldRegenerateHandler(gqlPath, handlerPath, schemaContent);
    
    if (!shouldRegenerate) {
      // Don't log anything when no changes
      continue;
    }
    
    const isNewFile = !fs.existsSync(handlerPath);
    fs.writeFileSync(handlerPath, handlerContent);
    markHandlerAsGenerated(gqlPath, handlerPath, schemaContent);
    
    if (isNewFile) {
      console.log(`Created ${handlerName} handler`);
    } else {
      console.log(`Regenerated ${handlerName} handler`);
    }
  }
};