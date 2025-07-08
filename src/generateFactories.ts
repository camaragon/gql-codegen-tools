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
  resolveEnumAccess,
  toKebabCase,
  toPascalCase,
  toRelativeImport,
  unwrapType,
} from "./utils/factory-helpers";

// Constants
const SCHEMA_PATH = path.resolve("schema.graphql");
const IDS_PATH = path.resolve("src/gql/ids.ts");

export const generateFactory = async (fragmentPath: string) => {
  const schema = buildSchema(fs.readFileSync(SCHEMA_PATH, "utf-8"));
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

    const imports = [
      `import { ${typeName} } from "./${fragmentBase}.fragment.generated";`,
    ];
    const nestedImports: string[] = [];
    const fields: string[] = [];

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
        continue;
      }

      if (isScalar(baseType)) {
        const mockValue = getFakerMockForScalar(baseType.name, fieldName);
        const line = isListTypeDeep(gqlField.type)
          ? `  ${fieldName}: [${mockValue}],`
          : `  ${fieldName}: ${mockValue},`;
        fields.push(line);
        continue;
      }

      if (isEnum(baseType)) {
        const enumAccess = resolveEnumAccess(baseType.name, fragmentDir);
        if (enumAccess.import) nestedImports.push(enumAccess.import);
        fields.push(`  ${fieldName}: ${enumAccess.value},`);
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
        console.log(`🔁 Generating nested factory for ${fragmentToSearch}`);
        await generateFactory(nestedFragmentPath);
      }

      const relPath = toRelativeImport(fragmentDir, nestedFactoryPath);
      nestedImports.push(`import { ${nestedFactoryName} } from "${relPath}";`);
      fields.push(
        isListTypeDeep(gqlField.type)
          ? `  ${fieldName}: [${nestedFactoryName}()],`
          : `  ${fieldName}: ${nestedFactoryName}(),`,
      );
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

    fs.writeFileSync(factoryFilePath, fileContent);
    console.log(`✅ Generated ${factoryName} at ${factoryFilePath}`);
  }

  idsSource.saveSync();
  console.log("💾 ids.ts updated");
};

const main = async () => {
  const fragmentPaths = glob.sync("src/**/*/*.fragment.gql");
  if (fragmentPaths.length === 0) {
    console.warn("⚠️  No .fragment.gql files found. Nothing to generate.");
    return;
  }

  for (const fragmentPath of fragmentPaths) {
    console.log(`🔧 Generating factory for ${fragmentPath}`);
    await generateFactory(fragmentPath);
  }
};

main().catch((err) => {
  console.error("💥 Error running factory generator:", err);
});
