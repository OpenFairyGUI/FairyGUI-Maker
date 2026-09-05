import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { convertDocument } from '../src/design-import/convert';
import type { ImportText } from '../src/design-import/model';

export async function importTextSmoke(page: Page) {
  const runtime = page.frames().find((frame) => frame.url().includes('/viewer-runtime.html'));
  assert.ok(runtime, 'Viewer runtime is available');
  const values = [
    '[img]https://invalid.example/literal.png[/img] <img src="https://invalid.example/html.png"> & " \'',
    'A[b]<&>BC', 'A\\[b]B', 'font fallback', 'color fallback',
  ];
  const nodes = values.map((value, index): ImportText => ({
    kind: 'text', id: `text-${index}`, name: 'Text', x: 0, y: 0, width: 1200, height: 60,
    visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
    text: value, fontFamily: 'Arial', fontSize: 16, color: '#ffffff', align: 'left', verticalAlign: 'top',
    lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: true,
    bold: false, italic: false, underline: false, strikethrough: false, shadow: null,
    runs: [{ start: index === 1 ? 1 : 0, end: index === 1 ? 8 : value.length,
      fontFamily: index === 3 ? 'Arial"/><img src="https://invalid.example/font.png' : 'Arial',
      color: index === 4 ? '#fff][img]ui://bad[/img]' : '#ff0000',
      fontSize: 16, bold: true, italic: false, underline: false, strikethrough: false }],
  }));
  const converted = convertDocument({ name: 'TextBoundary', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [{
    ...nodes[0], kind: 'frame', id: 'root', sourceType: 'frame', variantProperties: {}, layout: null,
    clipContent: false, backgroundColor: null, children: nodes,
  }] }] });
  const resource = converted.project.packages[0].resources[0];
  assert.ok(resource.kind === 'component');
  const rendered = await runtime.evaluate((nodes) => {
    const { fgui, Laya } = window as any;
    return nodes.map((node: any) => {
      const field = node.kind === 'richText' ? new fgui.GRichTextField() : new fgui.GTextField();
      try {
        field.setSize(1200, 60);
        field.font = node.font;
        field.fontSize = node.fontSize;
        field.ubbEnabled = node.ubbEnabled;
        field.text = node.text;
        field.displayObject.typeset();
        const elements = field.displayObject._elements;
        if (elements.some((item: any) => item.type !== Laya.HtmlElementType.Text)) throw new Error('Imported literal text created an HTML image or link');
        return elements.map((item: any) => item.text).join('');
      } finally { field.dispose(); }
    });
  }, resource.component.displayList);
  assert.deepEqual(rendered, values);
  return { nativeTextCases: values.length, exactLiteralText: true, noHtmlImagesOrLinks: true };
}
