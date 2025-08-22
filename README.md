# GraphQL Codegen Tools

A CLI tool for generating TypeScript mock factories and MSW handlers from GraphQL fragments and operations. Designed to streamline testing and development workflows in GraphQL-based TypeScript projects.

## Features

- **Factory Generation**: Creates type-safe mock factories from GraphQL fragments
- **Handler Generation**: Generates MSW (Mock Service Worker) handlers for GraphQL operations
- **Incremental Updates**: Only regenerates files when source fragments or schema change
- **Manual Customization**: Preserves manual modifications while adding new fields automatically
- **Dependency Resolution**: Automatically handles nested fragment dependencies
- **Cache Management**: Tracks generation history to optimize build times

## Installation

```bash
npm install -g gql-codegen-tools
```

Or install locally in your project:

```bash
npm install --save-dev gql-codegen-tools
```

## Usage

### Basic Commands

Generate factory files from GraphQL fragments:
```bash
gql-codegen-tools factories
```

Generate MSW handlers from GraphQL operations:
```bash
gql-codegen-tools handlers
```

### Project Structure Requirements

The tool expects your project to follow this structure:

```
project-root/
├── schema.graphql              # GraphQL schema file
├── src/
│   ├── gql/
│   │   └── ids.ts             # ID management file
│   └── components/
│       ├── user/
│       │   ├── user.fragment.gql
│       │   └── user.factory.ts      # Generated
│       └── posts/
│           ├── get-posts.query.gql
│           └── get-posts.handler.ts # Generated
```

### Integration with npm scripts

Add these scripts to your `package.json`:

```json
{
  "scripts": {
    "codegen:factories": "gql-codegen-tools factories",
    "codegen:handlers": "gql-codegen-tools handlers",
    "codegen": "npm run codegen:factories && npm run codegen:handlers",
    "dev": "npm run codegen && vite",
    "build": "npm run codegen && vite build",
    "test": "npm run codegen:factories && vitest"
  }
}
```

## Factory Generation

### Input: GraphQL Fragment

```graphql
# user.fragment.gql
fragment User on User {
  id
  name
  email
  isActive
}
```

### Output: TypeScript Factory

```typescript
// user.factory.ts
import { UserFragment } from "./user.fragment.generated";

const defaultUser: UserFragment = {
  id: ids.user[0],
  name: faker.person.name(),
  email: faker.internet.email(),
  isActive: faker.datatype.boolean(),
  __typename: "User",
};

export const createMockUser = (overwrites: Partial<UserFragment> = {}): UserFragment => ({
  ...defaultUser,
  ...overwrites,
});
```

### Manual Customization

You can customize generated factories and the tool will preserve your changes:

```typescript
// Manually customized factory
const defaultUser: UserFragment = {
  id: "test-user-123",        // Custom ID preserved
  name: faker.person.name(),  // Generated value updated automatically
  email: "test@example.com",  // Custom email preserved
  isActive: true,             // Custom boolean preserved
  __typename: "User",
};
```

When new fields are added to the fragment, they will be automatically inserted while preserving your customizations.

### Protecting Factories from Updates

Add a manual marker to prevent any automatic updates:

```typescript
// @manual
const defaultUser: UserFragment = {
  // This factory will never be auto-updated
};
```

## Handler Generation

### Input: GraphQL Operation

```graphql
# get-user.query.gql
query GetUser($id: ID!) {
  user(id: $id) {
    ...User
  }
}
```

### Output: MSW Handler

```typescript
// get-user.handler.ts
import { HttpResponse } from "msw";
import { fn } from "@storybook/test";
import { createMockUser } from "../user/user.factory";
import { mockGetUserQuery } from "./get-user.query.generated";

export const getUserSpy = fn();

export const getUser = mockGetUserQuery(({ variables }) => {
  getUserSpy(variables);
  return HttpResponse.json({
    data: {
      user: createMockUser(),
    },
  });
});

export default getUser;
```

## Configuration

### Cache File

The tool creates a `.gql-codegen-cache.json` file to track generation history. Add this to your `.gitignore`:

```gitignore
.gql-codegen-cache.json
```

### ID Management

Create an `src/gql/ids.ts` file for consistent ID generation:

```typescript
export const ids = {
  user: ["user-1", "user-2", "user-3"],
  post: ["post-1", "post-2", "post-3"],
  // Add more entity IDs as needed
};
```

## Development Workflow

### Watch Mode

For development, you can set up file watching:

```bash
npm install -D chokidar-cli concurrently
```

Add to package.json:
```json
{
  "scripts": {
    "codegen:watch": "chokidar \"src/**/*.fragment.gql\" \"src/**/*.{query,mutation}.gql\" \"schema.graphql\" -c \"npm run codegen\"",
    "dev": "concurrently \"npm run codegen:watch\" \"vite\""
  }
}
```

### CI/CD Integration

For continuous integration, ensure codegen runs before builds:

```yaml
# .github/workflows/ci.yml
- name: Generate code
  run: npm run codegen

- name: Build
  run: npm run build

- name: Test
  run: npm run test
```

## Dependencies

The generated code expects these peer dependencies:

```json
{
  "devDependencies": {
    "@faker-js/faker": "^9.0.0",
    "@storybook/test": "^7.0.0",
    "msw": "^2.0.0"
  }
}
```

## TypeScript Configuration

Ensure your `tsconfig.json` includes the generated files:

```json
{
  "include": [
    "src/**/*",
    "src/**/*.generated.ts"
  ]
}
```

## Troubleshooting

### "No .fragment.gql files found"
Ensure your GraphQL fragments are saved with the `.fragment.gql` extension in the `src/` directory.

### "Could not find default object"
This usually indicates a malformed factory file. Check that your factory follows the expected structure with a `const defaultObjectName: TypeName = { ... };` pattern.

### Factories not updating
Check if your factory has manual modifications. The tool preserves manual changes by default. To force regeneration, delete the factory file or clear the cache file.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

ISC License - see LICENSE file for details.