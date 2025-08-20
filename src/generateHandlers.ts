import path from "path";
import fs from "fs";
import glob from "fast-glob";
import {
  parse,
  Kind,
  FragmentSpreadNode,
  FieldNode,
  SelectionNode,
  visit,
  visitWithTypeInfo,
  isNonNullType,
  TypeInfo,
  GraphQLList,
  buildSchema,
  isObjectType,
  getNamedType,
} from "graphql";
import {
  toKebabCase,
  toPascalCase,
  toRelativeImport,
} from "./utils/factory-helpers";

// Recursively build mock object for a selection set
function buildMockObject(
  { selections }: { selections: readonly SelectionNode[] },
  fragmentMap: Record<string, any>,
  imports: Set<string>,
  factories: Set<string>,
  dir: string,
): string {
  let lines: string[] = [];
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD) {
      const field = sel as FieldNode;
      const name = field.name.value;
      if (field.selectionSet) {
        // Nested object
        lines.push(`  ${name}: {`);
        lines.push(
          buildMockObject(
            field.selectionSet,
            fragmentMap,
            imports,
            factories,
            dir,
          ),
        );
        lines.push(`    __typename: "${toPascalCase(name)}",`);
        lines.push(`  },`);
      } else {
        // Scalar or id
        lines.push(`  ${name}: "mock-${name}",`);
      }
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const frag = sel as FragmentSpreadNode;
      const fragName = frag.name.value;
      const factoryName = `createMock${fragName}`;
      const fragFile = glob.sync(
        `src/**/*/${toKebabCase(fragName)}.factory.ts`,
      )[0];
      if (fragFile) {
        const relImport = toRelativeImport(dir, fragFile);
        imports.add(`import { ${factoryName} } from "${relImport}";`);
        factories.add(factoryName);
        lines.push(`  ...${factoryName}(),`);
      } else {
        lines.push(`  // TODO: Factory for ${fragName} not found`);
      }
    }
  }
  return lines.map((l) => (l.startsWith("  ") ? l : "    " + l)).join("\n");
}

const schema = buildSchema(fs.readFileSync("schema.graphql", "utf-8"));

const main = async () => {
  const gqlFiles = glob.sync("src/**/*.{query,mutation}.gql");
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
    // Build fragment map
    const fragmentMap: Record<string, any> = {};
    for (const def of ast.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragmentMap[def.name.value] = def;
      }
    }
    // Build imports and factories
    const imports = new Set<string>();
    const factories = new Set<string>();
    // Build mock response
    const typeInfo = new TypeInfo(schema);
    let mockData = "";

    visit(
      operation,
      visitWithTypeInfo(typeInfo, {
        Field(node) {
          const parentType = typeInfo.getParentType();
          let fieldDef;
          if (parentType && isObjectType(parentType)) {
            fieldDef = parentType.getFields()[node.name.value];
          }
          const returnType = fieldDef?.type;

          const name = node.name.value;
          let namedType = returnType;
          while (isNonNullType(namedType) || namedType instanceof GraphQLList) {
            namedType = namedType.ofType;
          }

          const returnTypeName = getNamedType(namedType)?.name;
          const factoryName = `createMock${returnTypeName}`;
          factories.add(factoryName);

          // Detect if it's a list (unwrapping NonNulls)
          let type = returnType;
          while (isNonNullType(type)) type = type.ofType;
          const isList = type instanceof GraphQLList;

          const factoryCall = isList
            ? `[${factoryName}()]`
            : `${factoryName}()`;

          mockData += `      ${name}: ${factoryCall},\n`;

          // Try to find and add import
          if (returnTypeName) {
            const factoryPath = glob.sync(
              `src/**/*/${toKebabCase(returnTypeName)}.factory.ts`,
            )[0];
            if (factoryPath) {
              const relImport = toRelativeImport(dir, factoryPath);
              imports.add(`import { ${factoryName} } from "${relImport}";`);
            }
          }
        },
      }),
    );
    // Compose handler file
    let handlerContent = `import { HttpResponse } from "msw";
import { fn } from "@storybook/test";
${Array.from(imports).join("\n")}
${relMockHandlerImport ? `import { ${mockHandlerName} } from "${relMockHandlerImport}";` : "// TODO: mock handler import"}

export const ${spyName} = fn();

export const ${handlerName} = ${mockHandlerName}(({ variables }) => {
  ${spyName}(variables);
  return HttpResponse.json({
    data: {
${mockData}    },
  });
});

export default ${handlerName};
`;
    const baseFileName = path
      .basename(gqlPath)
      .replace(/\.(query|mutation)\.gql$/, "");
    const handlerPath = path.join(dir, `${baseFileName}.handler.ts`);
    fs.writeFileSync(handlerPath, handlerContent);
    console.log(`✅ Generated handler for ${opName} at ${handlerPath}`);
  }
};

main().catch((err) => {
  console.error("💥 Error running handler generator:", err);
});
