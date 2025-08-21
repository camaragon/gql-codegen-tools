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
} from "../lib/helpers";

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

