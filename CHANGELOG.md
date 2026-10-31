# Changelog

All notable changes to `kvdock` will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-28

### Added
- Core `KVDock` storage engine with zero-dependency TypeScript implementation.
- Built-in `MemoryAdapter` with sub-millisecond $O(1)$ LRU eviction and deterministic TTL management.
- Built-in `FsAdapter` with atomic JSON serialization and directory management.
- Complete dual ESM and CJS bundle targets built with `tsup`.
- Multi-language ecosystem parity specifications for Rust, Go, Swift, and Kotlin.
- Multi-stage CI pipeline verifying linting, type safety, and test suites.
- Architecture Decision Records (`001-core-architecture.md`, `002-error-handling-strategy.md`, `003-zero-dependency-policy.md`).

### Fixed
- Enforce strict TTL boundary validation rejecting non-positive and non-finite values (#31).
