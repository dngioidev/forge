<!-- forge:context:begin -->
## forge conventions (managed — do not edit inside this block)

- Verify command: `pnpm verify` — run it before reporting done.
- Commit format: conventional+issue-ref (`type(scope): subject (#issue)`).
- Specs live in `docs/specs`, plans in `docs/plans`.
- Reports end with the forge terminal JSON block (verdict + findings).

Shell rules (Windows-first):
- Spawn processes with argv arrays, never shell strings; `.cmd`/`.bat` scripts must go through `cmd.exe /d /s /c` with argv arrays.
- Compare paths case-insensitively and separator-agnostically; never hardcode `\` or `/`.
- Write files with explicit `utf8`; expect CRLF in checked-out text files; never assume `\n`-only.
- `%TEMP%`-style expansion does not work in POSIX shells; use environment variables through the process env, not string interpolation.
<!-- forge:context:end -->
