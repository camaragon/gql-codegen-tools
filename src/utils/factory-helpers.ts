import path from "path";
import fs from "fs";
import {
  GraphQLType,
  GraphQLNamedType,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  isListType,
  isNonNullType,
  parse,
  GraphQLObjectType,
} from "graphql";
import glob from "fast-glob";
import { faker } from "@faker-js/faker";

export const unwrapType = (type: GraphQLType): GraphQLNamedType => {
  while (type instanceof GraphQLNonNull || type instanceof GraphQLList) {
    type = type.ofType;
  }
  return type;
};

export const isScalar = (type: GraphQLNamedType): boolean =>
  type instanceof GraphQLScalarType ||
  ["String", "Int", "Float", "Boolean", "ID"].includes(type.name);

export const isEnum = (type: GraphQLNamedType): type is GraphQLEnumType =>
  type instanceof GraphQLEnumType;

export const isListTypeDeep = (type: GraphQLType): boolean =>
  isNonNullType(type) ? isListType(type.ofType) : isListType(type);

export const toKebabCase = (str: string): string =>
  str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

export const toPascalCase = (str: string): string =>
  str.replace(/(^\w|-\w)/g, (m) => m.replace("-", "").toUpperCase());

export const toCamelCase = (str: string): string =>
  str.charAt(0).toLowerCase() + str.slice(1);

export const toRelativeImport = (from: string, to: string): string => {
  const rel = path.relative(from, to).replace(/\\/g, "/").replace(/\.ts$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
};

export const getFieldFragmentMap = (content: string): Record<string, string> =>
  Object.fromEntries(
    [...content.matchAll(/(\w+)\s*\{\s*\.\.\.(\w+)/g)].map(
      ([_, field, frag]) => [field, frag],
    ),
  );

export const getTopLevelFragmentSpreads = (content: string): string[] =>
  parse(content).definitions.flatMap((def) =>
    def.kind === "FragmentDefinition"
      ? def.selectionSet.selections
          .filter((s) => s.kind === "FragmentSpread")
          .map((s) => s.name.value)
      : [],
  );

export const extractFragmentName = (filePath: string): string => {
  const content = fs.readFileSync(filePath, "utf-8");
  const match = content.match(/fragment (\w+) on/);
  if (!match) throw new Error(`Fragment name not found in ${filePath}`);
  return match[1];
};

export const handleIdField = (
  type: GraphQLObjectType,
  idsObject: any,
  baseType: GraphQLNamedType,
  idsImportPath: string,
  fields: string[],
  imports: string[],
): void => {
  const idsKey = toCamelCase(type.name);
  const isStringId = baseType.name === "String" || baseType.name === "ID";

  if (!idsObject.getProperty(idsKey)) {
    idsObject.addPropertyAssignment({
      name: idsKey,
      initializer: isStringId ? `["1", "2", "3"]` : `[1, 2, 3]`,
    });
  }

  imports.push(`import { ids } from "${idsImportPath}";`);
  fields.push(`  id: ids.${idsKey}[0],`);
};

export const getFakerMockForScalar = (scalar: string, name: string): string => {
  name = name.toLowerCase();

  if (scalar === "String") {
    if (name.includes("email")) return JSON.stringify(faker.internet.email());
    if (name.includes("fullname"))
      return JSON.stringify(faker.person.fullName());
    if (name.includes("first")) return JSON.stringify(faker.person.firstName());
    if (name.includes("last")) return JSON.stringify(faker.person.lastName());
    if (name.includes("username"))
      return JSON.stringify(faker.internet.username());
    if (name.includes("url") || name.includes("uri"))
      return JSON.stringify(faker.internet.url());
    if (name.includes("phone")) return JSON.stringify(faker.phone.number());
    if (name.includes("city")) return JSON.stringify(faker.location.city());
    if (name.includes("country"))
      return JSON.stringify(faker.location.country());
    if (name.includes("address"))
      return JSON.stringify(faker.location.streetAddress());
    return JSON.stringify(faker.lorem.words(1));
  }

  switch (scalar) {
    case "Int":
      return faker.number.int({ min: 0, max: 1_000 }).toString();
    case "Float":
      return faker.number
        .float({ min: 0, max: 1000, fractionDigits: 2 })
        .toString();
    case "Boolean":
      return faker.datatype.boolean() ? "true" : "false";
    case "Date":
    case "DateTime":
      return JSON.stringify(faker.date.recent().toISOString());
    default:
      return JSON.stringify(`mock-${name}`);
  }
};

export const resolveEnumAccess = (
  enumName: string,
  dir: string,
): { value: string; import?: string } => {
  const matches = glob
    .sync("src/**/*.ts", { absolute: true })
    .filter((file) =>
      new RegExp(`enum\\s+${enumName}\\b`).test(fs.readFileSync(file, "utf-8")),
    );

  const enumPath = matches[0];
  if (!enumPath) return { value: `'UNKNOWN'` };

  const match = fs
    .readFileSync(enumPath, "utf-8")
    .match(new RegExp(`enum\\s+${enumName}\\s*{([\\s\\S]*?)}`, "m"));
  if (!match) return { value: `'UNKNOWN'` };

  const key = match[1]
    .split(",")
    .map((l) =>
      l
        .replace(/\/\*.*?\*\//g, "")
        .replace(/\/\/.*$/, "")
        .trim(),
    )
    .filter(Boolean)[0]
    ?.split(":")[0]
    .split("=")[0]
    .trim();

  const value = `${enumName}.${key}`;
  const relPath = toRelativeImport(dir, enumPath);
  return { value, import: `import { ${enumName} } from "${relPath}";` };
};
