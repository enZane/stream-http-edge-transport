# Streamable HTTP Transport for Web Fetch API

![GitHub Repo stars](https://img.shields.io/github/stars/enzane/stream-http-edge-transport?style=social)
![npm](https://img.shields.io/npm/v/stremeable-http-transport?style=plastic) <!-- Consider if this should be the version of the main package or removed if multiple packages -->
![GitHub](https://img.shields.io/github/license/enzane/stream-http-edge-transport?style=plastic)
![GitHub top language](https://img.shields.io/github/languages/top/enzane/stream-http-edge-transport?style=plastic)
<!-- Removed download stats as they are package-specific -->

This repository hosts `EdgeStreamableHTTPTransport`, an edge-compatible server transport for the Model Context Protocol (MCP). It enables real-time, bi-directional communication using Server-Sent Events (SSE) and standard HTTP requests, making it suitable for modern web frameworks like Hono. The transport is designed to implement the MCP Streamable HTTP transport specification and is optimized for edge environments.

## Overview

The core of this project is to provide a reliable and efficient transport layer for applications requiring real-time data streaming, particularly those leveraging the Model Context Protocol. It's built with TypeScript and designed to be easily integrated into various server setups, especially those running on edge computing platforms.

## Packages

This monorepo contains the following primary package:

- **`packages/stremeable-http-transport`**:
  - Implements the `EdgeStreamableHTTPTransport`.
  - Supports SSE streaming and direct HTTP responses.
  - Features session management (stateful and stateless modes).
  - Includes resumability support via an extensible event store.
  - For more details, see the [package README](./packages/stremeable-http-transport/README.md).

## Development

This project utilizes a modern development stack to ensure code quality, maintainability, and ease of contribution.

### Tools

The development environment is configured with the following tools:

- **TypeScript**: For strong typing and modern JavaScript features.
- **pnpm workspaces**: For managing the monorepo structure and dependencies.
- **Vitest**: For fast and reliable unit and integration testing.
- **Biome**: For consistent code formatting and linting.
- **tsdown**: For efficient bundling of TypeScript code into CJS and ESM formats.
- **Changeset**: For streamlined version management and changelog generation.
- **GitHub Actions**: For automating CI/CD pipelines, including testing, building, and publishing.
- **Lefthook**: For managing Git hooks.

### Key Scripts (run from the repository root)

- `pnpm install`: Install dependencies for all packages.
- `pnpm run build`: Build all packages.
- `pnpm run test`: Run tests for all packages.
- `pnpm run check`: Lint and format code across the repository.
- `pnpm run dev`: Start the development environment, typically in watch mode for relevant packages.
- `pnpm changeset`: To create a new changeset for versioning.
- `pnpm changeset version`: To apply changesets and update package versions.

Please refer to the `package.json` in the root and within each package for more specific scripts.

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](./CONTRIBUTING.md) guide for details on how to contribute to this project, including information on reporting bugs, proposing features, and submitting pull requests.

Also, please adhere to our [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Security

For security vulnerabilities, please refer to our [SECURITY.MD](./SECURITY.MD) policy.

## License

This project is licensed under the terms of the [LICENSE](./LICENSE) file.
