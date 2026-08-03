# Vendored third-party web assets (NOTICE)

The cockpit browser UI (#354) vendors its terminal emulator as static assets so
the frontend is fully self-contained on `127.0.0.1` (no CDN, no network at load).
Every asset below is permissively licensed (MIT) — recorded here so the license
posture stays auditable even though these files are neither an npm nor a Python
dependency the license gate (`plugin/scripts/gates/license.mjs`) inspects.

| asset | package | version | license | source |
| --- | --- | --- | --- | --- |
| `xterm.js` | [xterm](https://www.npmjs.com/package/xterm) | 5.3.0 | MIT | https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js |
| `xterm.css` | [xterm](https://www.npmjs.com/package/xterm) | 5.3.0 | MIT | https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css |
| `xterm-addon-fit.js` | [xterm-addon-fit](https://www.npmjs.com/package/xterm-addon-fit) | 0.8.0 | MIT | https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js |

## xterm.js — MIT License

Copyright (c) 2017-2022, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair, Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

`xterm-addon-fit` is published by the same xterm.js authors under the same MIT
license.
