# Third-Party Notices

FairyGUI Maker redistributes the following frozen browser runtimes for its Viewer and Player iframes:

- LayaAir 3.3.10 — MIT, Copyright (c) 2022 layabox, https://github.com/layabox/LayaAir
- FairyGUI for Layabox — MIT, Copyright (c) 2015 fairygui.com, https://github.com/fairygui/FairyGUI-layabox

The runtime files were copied without modification from the matching assets in
`FairyGUI-Editor-Online`. Embedded copyright and license notices are retained.

| Distributed file | Bytes | SHA-256 |
|---|---:|---|
| `public/viewer-runtime/laya.core.js` | 713422 | `705b87809c65df552789b91a3c0060c61fe8fb7f27b8af153facedbefed1afce` |
| `public/viewer-runtime/laya.webgl_2D.js` | 184160 | `3af12edc8b1c419453fc1d59609b353db8348cd8262063ae3d3c9e25d4ab3602` |
| `public/viewer-runtime/fairygui.js` | 698425 | `932974a571598e000bf3a0321e8e882326f6a16aed510e18087529691bec8d48` |

`fairygui.js` also retains two third-party easing notices embedded by the upstream bundle:

- Daniele Giardini's easing port, subject to the [DOTween license](https://dotween.demigiant.com/license.php).
- Robert Penner's easing equations, Copyright (c) 2001 Robert Penner, under the BSD terms reproduced in the distributed file.

These notices describe redistributed third-party code only. They do not grant a license to FairyGUI Maker's own source code.

FairyGUI Maker's design import module also uses:

- ag-psd 31.0.2 — MIT, https://github.com/Agamnentzar/ag-psd
- openfig-core 0.4.1 — MIT, https://github.com/OpenFig-org/openfig-core
- @resvg/resvg-js 2.6.2 — MPL-2.0, https://github.com/yisibl/resvg-js

Tracked PSD and FIG regression fixtures retain their upstream bytes. Their exact source commits,
SHA-256 values, and license texts are recorded in `test/fixtures/design-import/README.md`.

## Generated web bundle notices

Every production Web build emits `dist/web/THIRD_PARTY_LICENSES.md` using Vite's dependency-aware license generator. That file is shipped in the npm tarball and contains the package name, version, SPDX expression, copyright notice, and complete license text for JavaScript dependencies that enter the generated bundle.

The generated file is the authoritative notice for those bundled JavaScript dependencies. The release smoke requires representative MIT, Apache-2.0, and ISC entries so a missing or disabled license build fails the release gate.

## Additional bundled assets

The following assets or worker dependencies are distributed by the Web build but are not currently discovered by Vite's JavaScript license generator:

- Geist Variable 5.3.0 — OFL-1.1, Copyright 2024 The Geist Project Authors, https://github.com/vercel/geist-font
- pako 2.2.0 — MIT AND Zlib, Copyright (c) 2014-2017 Vitaly Puzrin and Andrei Tuputcyn; zlib portions Copyright (c) 1995-2013 Jean-loup Gailly and Mark Adler, https://github.com/nodeca/pako
- Tailwind CSS 4.3.3 — MIT, Copyright (c) Tailwind Labs, Inc., https://github.com/tailwindlabs/tailwindcss
- tw-animate-css 1.4.0 — MIT, Copyright (c) 2025 Wombosvideo, https://github.com/Wombosvideo/tw-animate-css
- Floating UI runtime modules — MIT, Copyright (c) 2021-present Floating UI contributors, https://github.com/floating-ui/floating-ui

## Zlib License text

Copyright (c) 1995-2013 Jean-loup Gailly and Mark Adler

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

## SIL Open Font License text

Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

### PREAMBLE

The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

### DEFINITIONS

"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the copyright statement(s).

"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting, or substituting -- in part or in whole -- any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

### PERMISSION & CONDITIONS

Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1. Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.
2. Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.
3. No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.
4. The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.
5. The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

### TERMINATION

This license becomes null and void if any of the above conditions are not met.

### DISCLAIMER

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.

## MIT License text

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
