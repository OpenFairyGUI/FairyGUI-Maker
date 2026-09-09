# Third-party fixtures

这些文件用于验证真实 `.fig` 和 `.psd` 解析。除注明为衍生作品的 Racing UI Showcase
外，文件均保持上游原始字节并固定到具体上游提交。

| File | Source | SHA-256 |
| --- | --- | --- |
| `basic-shapes.fig` | [OpenFig CLI](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/basic-shapes.fig) | `c7cd6d3a8b338b28ea41c9a101f5eb0eecf731c562111025f9aec5d4ad87b028` |
| `clip-test.fig` | [OpenFig CLI](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/clip-test.fig) | `9007435e519d652f7b52da67825003d024571cfc24897e6d03c926ae31efa6ed` |
| `medium-complex.fig` | [OpenFig CLI](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/medium-complex.fig) | `5126634984cb7a441c8c12583f0cef916cf01dee8084c107a2d6abf75b54928e` |
| `type-layer.psd` | [psd-tools](https://github.com/psd-tools/psd-tools/blob/21114abe96b1d88a4d2a5df4001c30941f9c2bec/tests/psd_files/layers-minimal/type-layer.psd) | `b24e6f4c7277dd499ebb20c88ac06698f4563e75bfeb6aa6cb0d2466140fd81f` |
| `artboard.psd` | [psd-tools](https://github.com/psd-tools/psd-tools/blob/21114abe96b1d88a4d2a5df4001c30941f9c2bec/tests/psd_files/artboard.psd) | `86d3ccc572cfeec57b271467ba103fb9e32c4f33351276abbf4f962913072b81` |
| `mask.psd` | [psd-tools](https://github.com/psd-tools/psd-tools/blob/21114abe96b1d88a4d2a5df4001c30941f9c2bec/tests/psd_files/mask.psd) | `a6928c0e306022d474876e61f4b1dc5b7c1ed1e1cb422e6e72511da0a6aae90b` |
| `effects-enabled.psd` | [psd-tools](https://github.com/psd-tools/psd-tools/blob/21114abe96b1d88a4d2a5df4001c30941f9c2bec/tests/psd_files/effects/effects-enabled.psd) | `42815f35af3998fd2fa4785bca94bb79124063e228d43c1fd206f71cdc43de87` |
| `racing-ui-showcase.psd` | Derived from [Racing UI Kit](https://villesep.itch.io/racing-ui-kit) by Ville Seppänen, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | `134ddb75b1021e2e26d899dcd43da8787570a85c8fba669d6bd9a3d6ef495a9b` |

## License: Racing UI Showcase

`racing-ui-showcase.psd` is an adaptation of **Racing UI Kit** by Ville Seppänen,
licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The source
PSD SHA-256 is
`41a72978d99dea5ecb33dfcde4a1919b75c90d37ef7489d1eec29e5ed460ae4d`.
The adaptation selects and converts source raster layers to 8-bit RGB, arranges
them into six new 1280×720 artboards, and adds editable text plus `@fgui`
role/state annotations. It is not an unmodified upstream file and is not endorsed
by the original creator.

## License: psd-tools fixtures

Copyright (c) 2019 Kota Yamaguchi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## License: OpenFig CLI fixtures

Copyright (c) 2026 OpenFig Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
