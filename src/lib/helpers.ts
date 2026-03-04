import path from "path";
import fs from "fs";
import crypto from "crypto";
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

export const normalizeModulePath = (modulePath: string): string => {
  // Convert to posix paths
  let normalized = modulePath.replace(/\\/g, "/");
  
  // Drop file extensions
  normalized = normalized.replace(/\.(ts|js|tsx|jsx)$/, "");
  
  // Strip /index suffix
  normalized = normalized.replace(/\/index$/, "");
  
  // Collapse ./../ patterns
  const parts = normalized.split("/");
  const collapsed: string[] = [];
  
  for (const part of parts) {
    if (part === "..") {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== "..") {
        collapsed.pop();
      } else {
        collapsed.push(part);
      }
    } else if (part !== "." && part !== "") {
      collapsed.push(part);
    }
  }
  
  const result = collapsed.join("/");
  
  // Ensure relative paths start with ./ or ../
  if (result && !result.startsWith(".") && !result.startsWith("/")) {
    return "./" + result;
  }
  
  return result || ".";
};

export const resolveModule = (fromDir: string, rawPath: string): string => {
  // If it's a relative path, resolve it directly
  if (rawPath.startsWith("./") || rawPath.startsWith("../") || rawPath.startsWith("/")) {
    const resolved = path.resolve(fromDir, rawPath);
    const relative = path.relative(fromDir, resolved);
    return normalizeModulePath(relative);
  }
  
  // For bare module names (e.g., "models", "utilities"), walk up the directory tree
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  const indexFiles = extensions.map(ext => `index${ext}`);
  
  let currentDir = path.resolve(fromDir);
  
  // Walk up the directory tree
  while (currentDir !== path.dirname(currentDir)) {
    // Check direct file matches: <dir>/<raw>{,.ts,.tsx,.js}
    for (const ext of ["", ...extensions]) {
      const candidate = path.join(currentDir, `${rawPath}${ext}`);
      if (fs.existsSync(candidate)) {
        const relative = path.relative(fromDir, candidate);
        return normalizeModulePath(relative);
      }
    }
    
    // Check index file matches: <dir>/<raw>/index{.ts,.tsx,.js}
    const rawDir = path.join(currentDir, rawPath);
    if (fs.existsSync(rawDir) && fs.statSync(rawDir).isDirectory()) {
      for (const indexFile of indexFiles) {
        const candidate = path.join(rawDir, indexFile);
        if (fs.existsSync(candidate)) {
          const relative = path.relative(fromDir, rawDir);
          return normalizeModulePath(relative);
        }
      }
    }
    
    // Move up one directory
    currentDir = path.dirname(currentDir);
  }
  
  // If not found, return as-is but normalized (might be a node_modules import)
  return normalizeModulePath(rawPath);
};

export const getFieldFragmentMap = (content: string): Record<string, string> =>
  Object.fromEntries(
    [...content.matchAll(/(\w+)\s*\{\s*\.\.\.(\w+)/g)].map(
      ([_, field, frag]) => [field, frag],
    ),
  );

export const getTopLevelFragmentSpreads = (content: string): Set<string> => {
  const ast = parse(content);
  const spreads = new Set<string>();
  
  const collectFragmentSpreads = (selections: any[]): void => {
    for (const selection of selections) {
      if (selection.kind === "FragmentSpread") {
        spreads.add(selection.name.value);
      } else if (selection.kind === "InlineFragment" && selection.selectionSet) {
        collectFragmentSpreads(selection.selectionSet.selections);
      } else if (selection.kind === "Field" && selection.selectionSet) {
        collectFragmentSpreads(selection.selectionSet.selections);
      }
    }
  };
  
  ast.definitions.forEach((def) => {
    if (def.kind === "FragmentDefinition") {
      collectFragmentSpreads(def.selectionSet.selections);
    }
  });
  
  return spreads;
};

export const extractFragmentName = (filePath: string): string => {
  const content = fs.readFileSync(filePath, "utf-8");
  const match = content.match(/fragment (\w+) on/);
  if (!match) throw new Error(`Fragment name not found in ${filePath}`);
  return match[1];
};

export const getFragmentTypeCondition = (filePath: string): string => {
  const content = fs.readFileSync(filePath, "utf-8");
  const match = content.match(/fragment \w+ on (\w+)/);
  if (!match) throw new Error(`Fragment type condition not found in ${filePath}`);
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

interface CacheEntry {
  fragmentHash: string;
  schemaHash: string;
  lastGenerated: number;
  autoGenerated: boolean;
}

interface Cache {
  [factoryPath: string]: CacheEntry;
}

const CACHE_FILE = '.gql-codegen-cache.json';

export const loadCache = (): Cache => {
  if (!fs.existsSync(CACHE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch {
    return {};
  }
};

export const saveCache = (cache: Cache): void => {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
};

export const hasManualChanges = (factoryPath: string): boolean => {
  if (!fs.existsSync(factoryPath)) {
    return false;
  }

  const cache = loadCache();
  const cached = cache[factoryPath];
  
  if (!cached) {
    // No cache entry (e.g. fresh clone, cache cleared) — check for manual markers
    // rather than assuming manual, so auto-generated files can be regenerated
    return isManualFactory(factoryPath);
  }

  // Check if file was modified after our last generation
  const factoryStat = fs.statSync(factoryPath);
  return factoryStat.mtime.getTime() > cached.lastGenerated;
};

export const isManualFactory = (factoryPath: string): boolean => {
  if (!fs.existsSync(factoryPath)) {
    return false;
  }

  const content = fs.readFileSync(factoryPath, 'utf-8');
  
  // Look for explicit manual markers
  const manualMarkers = [
    /\/\/ @manual/i,
    /\/\* @manual/i,
    /\/\/ Manual factory/i,
    /\/\* Manual factory/i,
    /\/\/ Custom/i,
    /\/\/ Hand-crafted/i
  ];
  
  return manualMarkers.some(marker => marker.test(content));
};

export const shouldRegenerateFactory = (
  fragmentPath: string,
  factoryPath: string,
  schemaContent: string,
  currentFieldDefinitions: Record<string, string>,
): { shouldRegenerate: boolean; reason: string; requiresUpdate?: boolean; diff?: FieldDiff } => {
  if (!fs.existsSync(factoryPath)) {
    return { 
      shouldRegenerate: true, 
      reason: `Creating new factory` 
    };
  }

  const isManual = isManualFactory(factoryPath) || hasManualChanges(factoryPath);
  const diff = analyzeFactoryChanges(fragmentPath, factoryPath, schemaContent, currentFieldDefinitions);
  
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.typeChanged.length > 0;
  
  if (isManual && hasChanges) {
    return {
      shouldRegenerate: true,
      reason: `Manual factory needs updates`,
      requiresUpdate: true,
      diff
    };
  }
  
  if (isManual) {
    return { 
      shouldRegenerate: false, 
      reason: `` // Don't log when no changes
    };
  }

  // For auto-generated factories, check cache
  const cache = loadCache();
  const fragmentContent = fs.readFileSync(fragmentPath, 'utf-8');
  
  const currentFragmentHash = crypto.createHash('sha256').update(fragmentContent).digest('hex');
  const currentSchemaHash = crypto.createHash('sha256').update(schemaContent).digest('hex');
  
  const cached = cache[factoryPath];
  const shouldRegenerate = !cached || 
    cached.fragmentHash !== currentFragmentHash ||
    cached.schemaHash !== currentSchemaHash;

  if (shouldRegenerate) {
    return { 
      shouldRegenerate: true, 
      reason: `Regenerating auto-generated factory` 
    };
  } else {
    return { 
      shouldRegenerate: false, 
      reason: `` // Don't log when no changes
    };
  }
};

export const markFactoryAsGenerated = (
  fragmentPath: string,
  factoryPath: string,
  schemaContent: string,
): void => {
  const cache = loadCache();
  const fragmentContent = fs.readFileSync(fragmentPath, 'utf-8');
  
  cache[factoryPath] = {
    fragmentHash: crypto.createHash('sha256').update(fragmentContent).digest('hex'),
    schemaHash: crypto.createHash('sha256').update(schemaContent).digest('hex'),
    lastGenerated: Date.now(),
    autoGenerated: true
  };
  
  saveCache(cache);
};

interface FieldDiff {
  added: string[];
  removed: string[];
  typeChanged: string[];
  unchanged: string[];
}

export const analyzeFactoryChanges = (
  fragmentPath: string,
  factoryPath: string,
  schemaContent: string,
  currentFieldDefinitions: Record<string, string>,
): FieldDiff => {
  const cache = loadCache();
  const cached = cache[factoryPath];
  
  // Get current fragment fields
  const currentFragmentContent = fs.readFileSync(fragmentPath, 'utf-8');
  const currentFields = new Set<string>();
  
  // Extract field names from current fragment (more robust parsing)
  const fragmentFieldRegex = /^\s*(\w+)(?:\s*\{|\s*\(|\s*$)/gm;
  let match;
  
  while ((match = fragmentFieldRegex.exec(currentFragmentContent)) !== null) {
    const fieldName = match[1];
    if (fieldName !== 'fragment' && fieldName !== 'on' && fieldName !== '__typename') {
      currentFields.add(fieldName);
    }
  }

  if (!fs.existsSync(factoryPath)) {
    return {
      added: Array.from(currentFields),
      removed: [],
      typeChanged: [],
      unchanged: []
    };
  }

  // Get existing factory fields
  const factoryContent = fs.readFileSync(factoryPath, 'utf-8');
  const existingFields = new Set<string>();
  
  // Extract fields from factory object
  const factoryFieldRegex = /^\s*(\w+):\s*.+,?\s*$/gm;
  while ((match = factoryFieldRegex.exec(factoryContent)) !== null) {
    const fieldName = match[1];
    if (fieldName !== '__typename') {
      existingFields.add(fieldName);
    }
  }

  // Calculate differences
  const added = Array.from(currentFields).filter(field => !existingFields.has(field));
  const removed = Array.from(existingFields).filter(field => !currentFields.has(field));
  
  // Only mark fields as type-changed if we have actual evidence they changed
  // For now, be conservative and assume unchanged unless we have specific evidence
  const common_fields = Array.from(currentFields).filter(field => existingFields.has(field));
  
  const currentFragmentHash = crypto.createHash('sha256').update(currentFragmentContent).digest('hex');
  const currentSchemaHash = crypto.createHash('sha256').update(schemaContent).digest('hex');
  
  const fragmentChanged = cached && cached.fragmentHash !== currentFragmentHash;
  const schemaChanged = cached && cached.schemaHash !== currentSchemaHash;
  
  // Only consider fields type-changed if schema changed (not just fragment)
  // Fragment changes usually just add/remove fields, schema changes affect types
  const typeChanged = schemaChanged ? common_fields : [];
  
  return {
    added,
    removed,
    typeChanged,
    unchanged: common_fields.filter(field => !typeChanged.includes(field))
  };
};


interface UpdateManualFactoryOptions {
  mergedImports?: string[];
}

export const updateManualFactory = (
  factoryPath: string,
  diff: FieldDiff,
  newFieldDefinitions: Record<string, string>,
  options: UpdateManualFactoryOptions = {}
): boolean => {
  const { mergedImports = [] } = options;
  const factoryContent = fs.readFileSync(factoryPath, 'utf-8');
  
  // Create comprehensive import manager
  const importManager = new Map<string, Set<string>>(); // module -> symbols
  const literalImports = new Set<string>();
  
  // Parse existing imports
  const baseDir = path.dirname(factoryPath);
  const lines = factoryContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ')) continue;
    
    const namedMatch = trimmed.match(/^import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["'];?$/);
    if (namedMatch) {
      const [, importsStr, rawPath] = namedMatch;
      const resolvedPath = resolveModule(baseDir, rawPath);
      const normalizedPath = normalizeModulePath(resolvedPath);
      const symbols = importsStr.split(',').map(s => s.trim()).filter(Boolean);
      
      if (!importManager.has(normalizedPath)) {
        importManager.set(normalizedPath, new Set());
      }
      for (const symbol of symbols) {
        importManager.get(normalizedPath)!.add(symbol);
      }
    } else {
      literalImports.add(trimmed);
    }
  }
  
  // Merge in new imports
  for (const newImport of mergedImports) {
    const namedMatch = newImport.match(/^import\s*\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["'];?$/);
    if (namedMatch) {
      const [, importsStr, rawPath] = namedMatch;
      const resolvedPath = resolveModule(baseDir, rawPath);
      const normalizedPath = normalizeModulePath(resolvedPath);
      const symbols = importsStr.split(',').map(s => s.trim()).filter(Boolean);
      
      if (!importManager.has(normalizedPath)) {
        importManager.set(normalizedPath, new Set());
      }
      for (const symbol of symbols) {
        importManager.get(normalizedPath)!.add(symbol);
      }
    } else {
      literalImports.add(newImport);
    }
  }
  
  // Build final import lines
  const finalImports: string[] = [];
  finalImports.push(...Array.from(literalImports).sort());
  
  const sortedModules = Array.from(importManager.keys()).sort();
  for (const modulePath of sortedModules) {
    const symbols = importManager.get(modulePath)!;
    if (symbols.size > 0) {
      const sortedSymbols = Array.from(symbols).sort().join(', ');
      finalImports.push(`import { ${sortedSymbols} } from "${modulePath}";`);
    }
  }
  
  // Find the default object definition - handle nested objects properly
  const constMatch = factoryContent.match(/const\s+(\w+):\s*(\w+)\s*=\s*\{/);
  if (!constMatch) {
    console.warn(`Could not find default object in ${factoryPath}, skipping update`);
    return;
  }

  const objectName = constMatch[1];
  const typeName = constMatch[2];
  
  // Find the object body by counting braces
  const startIndex = constMatch.index! + constMatch[0].length - 1; // Start at the opening brace
  let braceCount = 0;
  let endIndex = startIndex;
  
  for (let i = startIndex; i < factoryContent.length; i++) {
    if (factoryContent[i] === '{') braceCount++;
    if (factoryContent[i] === '}') braceCount--;
    if (braceCount === 0) {
      endIndex = i;
      break;
    }
  }
  
  if (braceCount !== 0) {
    console.warn(`Could not find matching brace in ${factoryPath}, skipping update`);
    return;
  }
  
  const objectBody = factoryContent.substring(startIndex + 1, endIndex);
  const fullMatch = factoryContent.substring(constMatch.index!, endIndex + 2); // Include "};"
  
  // Parse existing fields
  const existingFields = new Map<string, string>();
  const fieldLines = objectBody.split('\n');
  
  for (const line of fieldLines) {
    const fieldMatch = line.match(/^\s*(\w+):\s*(.+?),?\s*$/);
    if (fieldMatch) {
      const [, fieldName, fieldValue] = fieldMatch;
      existingFields.set(fieldName, fieldValue.replace(/,$/, ''));
    }
  }

  // Build new object body
  const updatedFields = new Map<string, string>();
  const actualChanges: string[] = [];

  // Keep unchanged fields (preserve manual customizations)
  for (const field of diff.unchanged) {
    if (existingFields.has(field)) {
      updatedFields.set(field, existingFields.get(field)!);
    }
  }

  // Preserve any existing fields not in the diff (avoid deleting unknown keys in manual files)
  const processedFields = new Set([...diff.unchanged, ...diff.added, ...diff.typeChanged, ...diff.removed]);
  for (const [fieldName, fieldValue] of existingFields.entries()) {
    if (!processedFields.has(fieldName) && fieldName !== '__typename') {
      updatedFields.set(fieldName, fieldValue);
    }
  }

  // Add new fields
  for (const field of diff.added) {
    if (newFieldDefinitions[field] && newFieldDefinitions[field] !== "__KEEP_EXISTING__") {
      updatedFields.set(field, newFieldDefinitions[field]);
      actualChanges.push(`+${field}`);
    } else if (newFieldDefinitions[field] === "__KEEP_EXISTING__" && existingFields.has(field)) {
      // Preserve existing field value for __KEEP_EXISTING__ sentinel
      updatedFields.set(field, existingFields.get(field)!);
    }
  }

  // Update type-changed fields (but try to preserve custom values when possible)
  for (const field of diff.typeChanged) {
    if (newFieldDefinitions[field] && newFieldDefinitions[field] !== "__KEEP_EXISTING__") {
      const existingValue = existingFields.get(field);
      const newValue = newFieldDefinitions[field];
      
      // If the existing value looks like a default generated value, replace it
      // Otherwise, keep the custom value as-is
      if (existingValue && !isDefaultGeneratedValue(existingValue)) {
        updatedFields.set(field, existingValue);
        // Don't log as change since we're preserving the existing value
      } else {
        updatedFields.set(field, newValue);
        actualChanges.push(`~${field}`);
      }
    } else if (newFieldDefinitions[field] === "__KEEP_EXISTING__" && existingFields.has(field)) {
      // Preserve existing field value for __KEEP_EXISTING__ sentinel
      updatedFields.set(field, existingFields.get(field)!);
    }
  }

  // Add __typename at the end
  if (existingFields.has('__typename')) {
    updatedFields.set('__typename', existingFields.get('__typename')!);
  }

  // Build new object body
  const newObjectBody = Array.from(updatedFields.entries())
    .map(([key, value]) => `  ${key}: ${value},`)
    .join('\n');

  const newDefaultObject = `const ${objectName}: ${typeName} = {\n${newObjectBody}\n};`;
  
  // Build the complete updated content with merged imports
  let updatedContent = factoryContent;
  
  // Replace the object definition
  updatedContent = updatedContent.replace(fullMatch, newDefaultObject);
  
  // Handle imports if there are changes or new imports to merge
  if (actualChanges.length > 0 || finalImports.length > 0) {
    // Find where imports end and content begins
    const lines = updatedContent.split('\n');
    let importEndIndex = 0;
    
    // Find the last import line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('import ') || (line === '' && i < lines.length - 1 && lines[i + 1].trim().startsWith('import '))) {
        importEndIndex = i;
      } else if (line && !line.startsWith('import ') && importEndIndex > 0) {
        break;
      }
    }
    
    // Remove old imports and rebuild with merged imports
    const contentAfterImports = lines.slice(importEndIndex + 1);
    
    // Remove empty lines at the start of content
    while (contentAfterImports.length > 0 && contentAfterImports[0].trim() === '') {
      contentAfterImports.shift();
    }
    
    // Build new content with merged imports
    const newContent = [
      ...finalImports,
      '',
      ...contentAfterImports
    ].join('\n');
    
    updatedContent = newContent;
  }
  
  // Only write and log if there were actual changes
  if (actualChanges.length > 0) {
    fs.writeFileSync(factoryPath, updatedContent);
    console.log(`Updated ${factoryPath}: ${actualChanges.join(', ')}`);
    return true;
  }
  
  return false;
};

const isDefaultGeneratedValue = (value: string): boolean => {
  const trimmed = value.trim();
  
  // Be very conservative - only update values that are clearly auto-generated patterns
  return (
    // Faker calls
    /^faker\./.test(trimmed) ||
    // Mock string patterns
    /^"mock-\w+"$/.test(trimmed) ||
    // Factory function calls
    /^createMock\w+\(\)$/.test(trimmed) ||
    // Arrays with factory calls
    /^\[createMock\w+\(\)\]$/.test(trimmed) ||
    // Empty arrays or null/undefined
    trimmed === '[]' || trimmed === 'null' || trimmed === 'undefined'
    // Deliberately NOT including numbers, booleans, or custom strings
  );
};

export const shouldRegenerateHandler = (
  gqlPath: string,
  handlerPath: string,
  schemaContent: string,
): { shouldRegenerate: boolean; reason: string } => {
  if (!fs.existsSync(handlerPath)) {
    return { 
      shouldRegenerate: true, 
      reason: `Creating new handler` 
    };
  }

  // Check if handler is manually modified (has manual markers)
  const handlerContent = fs.readFileSync(handlerPath, 'utf-8');
  const manualMarkers = [
    /\/\/ @manual/i,
    /\/\* @manual/i,
    /\/\/ Manual handler/i,
    /\/\* Manual handler/i,
    /\/\/ Custom/i,
  ];
  
  const isManualHandler = manualMarkers.some(marker => marker.test(handlerContent));
  
  if (isManualHandler) {
    return { 
      shouldRegenerate: false, 
      reason: `` // Don't log for manual handlers
    };
  }

  // Check cache for previous generation
  const cache = loadCache();
  const cached = cache[handlerPath];
  
  if (!cached) {
    // No cache entry (e.g. fresh clone, cache cleared) — regenerate unless manually marked
    return {
      shouldRegenerate: true,
      reason: `No cache entry found, regenerating handler`
    };
  }

  // Check if handler was manually modified after our last generation
  const handlerStat = fs.statSync(handlerPath);
  const wasManuallyModified = handlerStat.mtime.getTime() > cached.lastGenerated;
  
  if (wasManuallyModified) {
    return { 
      shouldRegenerate: false, 
      reason: `` // Don't log for manually modified handlers
    };
  }

  // Check for changes in source files
  const gqlContent = fs.readFileSync(gqlPath, 'utf-8');
  const currentGqlHash = crypto.createHash('sha256').update(gqlContent).digest('hex');
  const currentSchemaHash = crypto.createHash('sha256').update(schemaContent).digest('hex');
  
  const shouldRegenerate = cached.fragmentHash !== currentGqlHash ||
    cached.schemaHash !== currentSchemaHash;

  if (shouldRegenerate) {
    return { 
      shouldRegenerate: true, 
      reason: `Regenerating handler` 
    };
  } else {
    return { 
      shouldRegenerate: false, 
      reason: `` // Don't log when no changes
    };
  }
};

export const markHandlerAsGenerated = (
  gqlPath: string,
  handlerPath: string,
  schemaContent: string,
): void => {
  const cache = loadCache();
  const gqlContent = fs.readFileSync(gqlPath, 'utf-8');
  
  cache[handlerPath] = {
    fragmentHash: crypto.createHash('sha256').update(gqlContent).digest('hex'),
    schemaHash: crypto.createHash('sha256').update(schemaContent).digest('hex'),
    lastGenerated: Date.now(),
    autoGenerated: true
  };
  
  saveCache(cache);
};
