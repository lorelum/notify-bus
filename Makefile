# The platform CI contract: `make ci` must install the project's own
# dependencies from a fresh checkout and then run every check. Nothing here may
# depend on a developer machine, a pre-populated node_modules, or another repo.
.PHONY: ci install lint fmt-check typecheck test build

ci: install lint fmt-check typecheck test build

install:
	bun install --frozen-lockfile

lint:
	bun run lint

fmt-check:
	bun run fmt:check

typecheck:
	bun run typecheck

test:
	bun test

build:
	bun run build
