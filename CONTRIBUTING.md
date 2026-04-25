# Contributing to Spacefolding

First off, thank you for considering contributing to Spacefolding. It's people like you that make this tool better for everyone.

## Code of Conduct

This project and everyone participating in it is governed by basic decency and respect. Be kind, be constructive, and remember there's a human on the other side of every issue and PR.

## How to Contribute

### Reporting Bugs

Open a [GitHub Issue](https://github.com/BColsey/spacefolding/issues) with:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node version, Docker version)

### Suggesting Features

Open a GitHub Issue with the `enhancement` label. Describe:

- The use case
- Why existing functionality doesn't cover it
- Any implementation ideas you have

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Add tests for any new functionality
5. Ensure all existing tests pass (`npm test`)
6. Ensure the build succeeds (`npm run build`)
7. Commit with a descriptive message
8. Open a pull request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/spacefolding.git
cd spacefolding

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run in dev mode
npm run dev
```

### Code Style

- TypeScript strict mode — no `any` unless absolutely necessary
- Clean, readable code with minimal indirection
- One function, one job
- Public methods get docstrings
- No mocks in tests — test real behavior

### Project Structure

```
src/
├── core/        # Business logic (scoring, routing, classification)
├── providers/   # Pluggable providers (embedding, compression, etc.)
├── storage/     # SQLite persistence
├── pipeline/    # Pipeline orchestration
├── mcp/         # MCP server
├── web/         # Web UI
├── cli/         # CLI interface
└── types/       # TypeScript types
tests/           # Test files
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
