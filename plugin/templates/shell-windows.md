Shell rules (Windows-first):
- Spawn processes with argv arrays, never shell strings; `.cmd`/`.bat` scripts must go through `cmd.exe /d /s /c` with argv arrays.
- Compare paths case-insensitively and separator-agnostically; never hardcode `\` or `/`.
- Write files with explicit `utf8`; expect CRLF in checked-out text files; never assume `\n`-only.
- `%TEMP%`-style expansion does not work in POSIX shells; use environment variables through the process env, not string interpolation.
