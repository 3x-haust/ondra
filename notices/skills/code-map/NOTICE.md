# Sources

`code-map` borrows ideas from groma.md (https://github.com/MrLesk/Groma.md, read at
`0b908d8`, v0.7.8): a C4 map of the repository (system → containers → components)
kept as a file next to the code, components that own source files, curation by
people and agents that later checks keep, and asking which part owns a file before
changing it. No Groma code or text is copied. `codemap.mjs from-groma` reads the
`groma/` folder layout and Markdown contract that Groma documents
(`docs/component-markdown.md`), so a repo that already has a Groma map starts from it.

groma.md is under the MIT License:

    MIT License

    Copyright (c) 2026 Alex Gavrilescu

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
