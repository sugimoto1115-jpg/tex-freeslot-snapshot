import * as vscode from 'vscode';

type HeadingKind =
  | 'part'
  | 'chapter'
  | 'section'
  | 'subsection'
  | 'subsubsection';

const LEVEL: Record<HeadingKind, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4
};

function isTeXDocument(doc: vscode.TextDocument | undefined): doc is vscode.TextDocument {
  if (!doc) return false;
  const name = doc.fileName.toLowerCase();
  return name.endsWith('.tex') || doc.languageId === 'latex' || doc.languageId === 'tex';
}

function baseName(pathValue: string): string {
  const s = pathValue.replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function parseBalanced(text: string, openBraceIndex: number): { content: string; end: number } | null {
  if (openBraceIndex < 0 || openBraceIndex >= text.length) return null;
  if (text[openBraceIndex] !== '{') return null;

  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return {
          content: text.slice(openBraceIndex + 1, i),
          end: i
        };
      }
    }
  }
  return null;
}

class InfoItem extends vscode.TreeItem {
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class HeadingItem extends vscode.TreeItem {
  public children: HeadingItem[] = [];
  public readonly idKey: string;

  constructor(
    public readonly kind: HeadingKind,
    public readonly titleText: string,
    public readonly line: number,
    public readonly uri: vscode.Uri
  ) {
    super(titleText || '(empty)', vscode.TreeItemCollapsibleState.None);
    this.description = `L${line + 1}`;
    this.tooltip = `${kind}: ${titleText}\n${uri.fsPath}:${line + 1}`;
    this.idKey = `${uri.toString()}::${line}::${kind}::${titleText}`;
    this.iconPath = new vscode.ThemeIcon('list-tree');
  }
}

class TeXOutlineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private expandedState = new Map<string, boolean>();

  refresh(): void {
    this.emitter.fire();
  }

  toggle(item: HeadingItem): void {
    if (item.children.length === 0) return;
    const current = this.expandedState.get(item.idKey);
    this.expandedState.set(item.idKey, !(current ?? true));
    this.refresh();
  }

  private isExpanded(item: HeadingItem): boolean {
    return this.expandedState.get(item.idKey) ?? true;
  }

  private getActiveTeXDocument(): vscode.TextDocument | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    return isTeXDocument(doc) ? doc : undefined;
  }

  private extractFlat(doc: vscode.TextDocument): HeadingItem[] {
    const text = doc.getText();
    const re = /\\(subsubsection|subsection|section|chapter|part)\*?(?:\[[^\]]*\])?\s*\{/g;

    const out: HeadingItem[] = [];
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
      const kind = m[1] as HeadingKind;
      const openBraceIndex = re.lastIndex - 1;
      const parsed = parseBalanced(text, openBraceIndex);
      if (!parsed) continue;

      const title = parsed.content.replace(/\s+/g, ' ').trim();
      const line = doc.positionAt(m.index).line;
      out.push(new HeadingItem(kind, title, line, doc.uri));

      re.lastIndex = parsed.end + 1;
    }

    return out;
  }

  private buildTree(flat: HeadingItem[]): HeadingItem[] {
    const roots: HeadingItem[] = [];
    const stack: HeadingItem[] = [];

    for (const item of flat) {
      while (
        stack.length > 0 &&
        LEVEL[stack[stack.length - 1].kind] >= LEVEL[item.kind]
      ) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(item);
      } else {
        stack[stack.length - 1].children.push(item);
      }

      stack.push(item);
    }

    const applyState = (nodes: HeadingItem[]) => {
      for (const node of nodes) {
        node.collapsibleState =
          node.children.length > 0 && this.isExpanded(node)
            ? vscode.TreeItemCollapsibleState.Expanded
            : node.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        node.command = {
          command: 'texcloud.openOutlineItem',
          title: 'Open',
          arguments: [node]
        };

        applyState(node.children);
      }
    };

    applyState(roots);
    return roots;
  }

  private getTreeRoots(): vscode.TreeItem[] {
    const doc = this.getActiveTeXDocument();
    if (!doc) {
      return [new InfoItem('Active editor is not a TeX file')];
    }

    const flat = this.extractFlat(doc);
    return [
      new InfoItem(`${baseName(doc.fileName)} : ${flat.length} headings`),
      ...this.buildTree(flat)
    ];
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
    if (!element) {
      return Promise.resolve(this.getTreeRoots());
    }

    if (element instanceof HeadingItem) {
      if (!this.isExpanded(element)) {
        return Promise.resolve([]);
      }
      return Promise.resolve(element.children);
    }

    return Promise.resolve([]);
  }

  countHeadings(): number {
    const doc = this.getActiveTeXDocument();
    if (!doc) return 0;
    return this.extractFlat(doc).length;
  }
}

export function setupTeXOutline(context: vscode.ExtensionContext): void {
  const provider = new TeXOutlineProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('texcloudOutline', provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('texcloud.refreshOutline', () => {
      provider.refresh();
      const doc = vscode.window.activeTextEditor?.document;
      if (isTeXDocument(doc)) {
        void vscode.window.showInformationMessage(
          `${baseName(doc.fileName)} : ${provider.countHeadings()} headings`
        );
      } else {
        void vscode.window.showInformationMessage('Active editor is not a TeX file');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.openOutlineItem',
      async (item: HeadingItem) => {
        const doc = await vscode.workspace.openTextDocument(item.uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        const pos = new vscode.Position(item.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);

        if (item.children.length > 0) {
          provider.toggle(item);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const active = vscode.window.activeTextEditor?.document;
      if (active && e.document === active) {
        provider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const active = vscode.window.activeTextEditor?.document;
      if (active && doc === active) {
        provider.refresh();
      }
    })
  );

  setTimeout(() => provider.refresh(), 200);
  setTimeout(() => provider.refresh(), 1000);
}
