import * as path from 'path';
import * as vscode from 'vscode';
import { setupTeXOutline } from './outline';

let buildScriptPath = '';
const EXTERNAL_PDF_BASE = 'https://tex.freeslot-schedule.com/pdf';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getActiveTexDocument(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage('No active editor.');
    return undefined;
  }

  const doc = editor.document;

  if (doc.isUntitled) {
    void vscode.window.showErrorMessage('Please save the .tex file first.');
    return undefined;
  }

  if (path.extname(doc.fileName).toLowerCase() !== '.tex') {
    void vscode.window.showErrorMessage('Active file is not a .tex file.');
    return undefined;
  }

  return doc;
}

async function runShellTask(
  doc: vscode.TextDocument,
  label: string,
  command: string
): Promise<void> {
  await doc.save();

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  const scope = workspaceFolder ?? vscode.TaskScope.Workspace;

  const task = new vscode.Task(
    { type: 'shell' },
    scope,
    label,
    'texcloud-plus',
    new vscode.ShellExecution(command),
    []
  );

  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    focus: false
  };

  await vscode.tasks.executeTask(task);
}

async function smartBuild(): Promise<void> {
  const doc = getActiveTexDocument();
  if (!doc) {
    return;
  }

  if (!buildScriptPath) {
    void vscode.window.showErrorMessage('Build script path is not initialized.');
    return;
  }

  const tex = path.basename(doc.uri.fsPath);
  const command =
    `/bin/bash ${shellQuote(buildScriptPath)} ${shellQuote(doc.uri.fsPath)}`;

  await runShellTask(doc, `Smart Build ${tex}`, command);
}

async function closeExistingPdfTabs(pdfUri: vscode.Uri): Promise<void> {
  const targets: vscode.Tab[] = [];

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri?.toString() === pdfUri.toString()) {
        targets.push(tab);
      }
    }
  }

  if (targets.length > 0) {
    await vscode.window.tabGroups.close(targets, true);
  }
}

function detectEngineFromText(text: string): 'lualatex' | 'platex' | 'uplatex' {
  const magic = text.match(/^\s*%\s*!TeX\s+program\s*=\s*(.+?)\s*$/im);
  if (magic) {
    const p = magic[1].toLowerCase();
    if (p.includes('platex') || p.includes('ptex2pdf')) {
      return 'platex';
    }
    if (p.includes('lua')) {
      return 'lualatex';
    }
  }

  const uncommented = text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*%.*$/gm, '');

  if (/\\documentclass(?:\[[^\]]*\])?\{(?:j|js)(?:article|book|report)\}/i.test(uncommented)) {
    return 'platex';
  }

  return 'lualatex';
}

async function getRootTexUri(doc: vscode.TextDocument): Promise<vscode.Uri> {
  const maxLines = Math.min(doc.lineCount, 80);
  const head = doc.getText(new vscode.Range(0, 0, maxLines, 0));
  const m = head.match(/^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/im);

  if (!m) {
    return doc.uri;
  }

  const rootRaw = m[1].trim();
  const resolved = path.isAbsolute(rootRaw)
    ? rootRaw
    : path.resolve(path.dirname(doc.uri.fsPath), rootRaw);

  return vscode.Uri.file(resolved);
}

async function restoreTocAfterPdfOpen(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.texcloud');
  } catch {}
  try {
    await vscode.commands.executeCommand('texcloud.refreshOutline');
  } catch {}
}

async function openPdf(): Promise<void> {
  const doc = getActiveTexDocument();
  if (!doc) {
    return;
  }

  const rootUri = await getRootTexUri(doc);
  const rootDir = path.dirname(rootUri.fsPath);
  const rootBase = path.basename(rootUri.fsPath, path.extname(rootUri.fsPath));
  const pdfFsPath = path.join(rootDir, `${rootBase}.pdf`);
  const pdfUri = vscode.Uri.file(pdfFsPath);

  const relativePdfPath = path
    .relative('/home/coder/project', pdfFsPath)
    .replace(/\\/g, '/');

  const externalUrl =
    `${EXTERNAL_PDF_BASE}/${encodeURI(relativePdfPath)}?ts=${Date.now()}`;

  const mode = getPdfPreviewMode();
  const engine = detectEngineFromText(doc.getText());

  if (mode === 'external') {
    await openPdfExternal(externalUrl);
    return;
  }

  if (mode === 'internal') {
    await openPdfInternal(pdfUri);
    return;
  }

  if (engine === 'platex') {
    await openPdfExternal(externalUrl);
    return;
  }

  await openPdfInternal(pdfUri);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.setPdfPreviewMode',
      setPdfPreviewMode
    )
  );
  registerTableFigureHelper(context);
  registerEnvironmentHelper(context);
  registerTemplateHelper(context);
  registerSizeDocclassHelpers(context);
  registerInsertHelpers(context);
  
  context.subscriptions.push(
    vscode.commands.registerCommand('texcloud.downloadPdf', downloadPdf)
  );

setupTeXOutline(context);
  buildScriptPath = path.join(context.extensionPath, 'scripts', 'texcloud-build.sh');

  context.subscriptions.push(
    vscode.commands.registerCommand('texcloud.smartBuild', smartBuild),
    vscode.commands.registerCommand('texcloud.openPdf', openPdf)
  );

  void vscode.window.setStatusBarMessage('TeX Cloud Plus loaded', 3000);
}

export function deactivate(): void {}

// ==== texcloud insert helpers begin ====
function getActiveEditorForInsert(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage('No active editor.');
    return undefined;
  }
  return editor;
}

async function wrapSelectionOrInsert(
  prefix: string,
  suffix: string
): Promise<void> {
  const editor = getActiveEditorForInsert();
  if (!editor) {
    return;
  }

  const originalSelections = editor.selections.map(
    (s) => new vscode.Selection(s.start, s.end)
  );

  await editor.edit((editBuilder) => {
    for (const sel of originalSelections) {
      const text = editor.document.getText(sel);
      if (sel.isEmpty) {
        editBuilder.insert(sel.start, `${prefix}${suffix}`);
      } else {
        editBuilder.replace(sel, `${prefix}${text}${suffix}`);
      }
    }
  });

  const newSelections: vscode.Selection[] = [];
  for (const sel of originalSelections) {
    if (sel.isEmpty) {
      const pos = sel.start.translate(0, prefix.length);
      newSelections.push(new vscode.Selection(pos, pos));
    }
  }

  if (newSelections.length > 0) {
    editor.selections = newSelections;
  }
}

async function insertTextStyle(): Promise<void> {
  const items = [
    { label: 'Bold', prefix: '\\textbf{', suffix: '}' },
    { label: 'Italic', prefix: '\\textit{', suffix: '}' },
    { label: 'Underline', prefix: '\\underline{', suffix: '}' },
    { label: 'Box', prefix: '\\fbox{', suffix: '}' }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a text style'
  });

  if (!picked) {
    return;
  }

  await wrapSelectionOrInsert(picked.prefix, picked.suffix);
}

async function insertMathFont(): Promise<void> {
  const items = [
    { label: 'Roman', prefix: '\\mathrm{', suffix: '}' },
    { label: 'Bold', prefix: '\\mathbf{', suffix: '}' },
    { label: 'Italic', prefix: '\\mathit{', suffix: '}' },
    { label: 'Sans', prefix: '\\mathsf{', suffix: '}' },
    { label: 'Typewriter', prefix: '\\mathtt{', suffix: '}' },
    { label: 'Calligraphic', prefix: '\\mathcal{', suffix: '}' },
    { label: 'Blackboard bold', prefix: '\\mathbb{', suffix: '}' },
    { label: 'Bold symbol', prefix: '\\boldsymbol{', suffix: '}' }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a math font'
  });

  if (!picked) {
    return;
  }

  await wrapSelectionOrInsert(picked.prefix, picked.suffix);
}

function registerInsertHelpers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertTextStyle',
      insertTextStyle
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertMathFont',
      insertMathFont
    )
  );
}
// ==== texcloud insert helpers end ====

// ==== texcloud size/docclass begin ====
async function insertFontSize(): Promise<void> {
  const items = [
    { label: 'tiny', prefix: '{\\tiny ', suffix: '}' },
    { label: 'scriptsize', prefix: '{\\scriptsize ', suffix: '}' },
    { label: 'footnotesize', prefix: '{\\footnotesize ', suffix: '}' },
    { label: 'small', prefix: '{\\small ', suffix: '}' },
    { label: 'normalsize', prefix: '{\\normalsize ', suffix: '}' },
    { label: 'large', prefix: '{\\large ', suffix: '}' },
    { label: 'Large', prefix: '{\\Large ', suffix: '}' },
    { label: 'LARGE', prefix: '{\\LARGE ', suffix: '}' },
    { label: 'huge', prefix: '{\\huge ', suffix: '}' },
    { label: 'Huge', prefix: '{\\Huge ', suffix: '}' }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a font size'
  });

  if (!picked) {
    return;
  }

  await wrapSelectionOrInsert(picked.prefix, picked.suffix);
}

async function insertDocumentClass(): Promise<void> {
  const items = [
    { label: 'article', value: '\\documentclass{article}\n' },
    { label: 'report', value: '\\documentclass{report}\n' },
    { label: 'book', value: '\\documentclass{book}\n' },
    { label: 'jsarticle', value: '\\documentclass{jsarticle}\n' },
    { label: 'jsreport', value: '\\documentclass{jsreport}\n' },
    { label: 'jsbook', value: '\\documentclass{jsbook}\n' },
    { label: 'ltjsarticle', value: '\\documentclass{ltjsarticle}\n' },
    { label: 'ltjsreport', value: '\\documentclass{ltjsreport}\n' },
    { label: 'ltjsbook', value: '\\documentclass{ltjsbook}\n' }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a document class'
  });

  if (!picked) {
    return;
  }

  const editor = getActiveEditorForInsert();
  if (!editor) {
    return;
  }

  await editor.edit((editBuilder) => {
    editBuilder.insert(editor.selection.active, picked.value);
  });
}

function registerSizeDocclassHelpers(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertFontSize',
      insertFontSize
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertDocumentClass',
      insertDocumentClass
    )
  );
}
// ==== texcloud size/docclass end ====

// ==== texcloud template begin ====
async function insertTemplate(): Promise<void> {
  const templateLuaA4 = String.raw`\documentclass[a4paper]{ltjsarticle}
\usepackage[top=25truemm,bottom=25truemm,left=25truemm,right=25truemm]{geometry}

\title{}
\author{}
\date{\today}
\pagestyle{plain}

\usepackage{amsmath,amssymb,amsthm}
\usepackage{bm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}

\begin{document}

\maketitle

\section{はじめに}

本文

\end{document}
`;

  const items = [
    {
      label: 'LuaLaTeX A4 Standard',
      description: 'ltjsarticle + geometry + math/figure/table packages',
      value: templateLuaA4
    }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a template'
  });

  if (!picked) {
    return;
  }

  const editor = getActiveEditorForInsert();
  if (!editor) {
    return;
  }

  await editor.edit((editBuilder) => {
    if (editor.document.getText().trim().length === 0) {
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
      );
      editBuilder.replace(fullRange, picked.value);
    } else {
      editBuilder.insert(editor.selection.active, picked.value);
    }
  });
}

function registerTemplateHelper(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertTemplate',
      insertTemplate
    )
  );
}
// ==== texcloud template end ====

// ==== texcloud environment begin ====
async function insertSnippetBody(body: string): Promise<void> {
  const editor = getActiveEditorForInsert();
  if (!editor) {
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(body), editor.selection.active);
}

async function insertEnvironment(): Promise<void> {
  const items = [
    {
      label: 'equation',
      description: '\\begin{equation} ... \\end{equation}',
      body: "\\begin{equation}\n\t$1\n\\end{equation}"
    },
    {
      label: 'eqnarray',
      description: '\\begin{eqnarray} ... \\end{eqnarray}',
      body: "\\begin{eqnarray}\n\t$1\n\\end{eqnarray}"
    },
    {
      label: 'array',
      description: '\\begin{array}{cc} ... \\end{array}',
      body: "\\begin{array}{\\${1:cc}}\n\t$2\n\\end{array}"
    },
    {
      label: 'list',
      description: '\\begin{list}{...}{...} ... \\end{list}',
      body: "\\begin{list}{$1}{$2}\n\t\\item $3\n\\end{list}"
    },
    {
      label: 'itemize',
      description: '\\begin{itemize} ... \\end{itemize}',
      body: "\\begin{itemize}\n\t\\item $1\n\\end{itemize}"
    },
    {
      label: 'enumerate',
      description: '\\begin{enumerate} ... \\end{enumerate}',
      body: "\\begin{enumerate}\n\t\\item $1\n\\end{enumerate}"
    }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose an environment'
  });

  if (!picked) {
    return;
  }

  await insertSnippetBody(picked.body);
}

function registerEnvironmentHelper(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertEnvironment',
      insertEnvironment
    )
  );
}
// ==== texcloud environment end ====

// ==== texcloud table-figure begin ====
async function insertTableFigure(): Promise<void> {
  const items = [
    {
      label: 'figure',
      description: '\\begin{figure}[tbp] ... \\end{figure}',
      body: [
        '\\begin{figure}[tbp]',
        '\t\\centering',
        '\t\\includegraphics[width=0.8\\\\linewidth]{$1}',
        '\t\\caption{$2}',
        '\t\\label{fig:$3}',
        '\\end{figure}'
      ].join('\n')
    },
    {
      label: 'table',
      description: '\\begin{table}[tbp] ... \\end{table}',
      body: [
        '\\begin{table}[tbp]',
        '\t\\centering',
        '\t\\caption{$1}',
        '\t\\label{tab:$2}',
        '\t\\begin{tabular}{${3:cc}}',
        '\t\t\\\\hline',
        '\t\t$4 & $5 \\\\\\\\',
        '\t\t\\\\hline',
        '\t\\end{tabular}',
        '\\end{table}'
      ].join('\n')
    },
    {
      label: 'tabular',
      description: '\\begin{tabular}{cc} ... \\end{tabular}',
      body: [
        '\\begin{tabular}{${1:cc}}',
        '\t\\\\hline',
        '\t$2 & $3 \\\\\\\\',
        '\t\\\\hline',
        '\\end{tabular}'
      ].join('\n')
    }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose a table/figure block'
  });

  if (!picked) {
    return;
  }

  await insertSnippetBody(picked.body);
}

function registerTableFigureHelper(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texcloud.insertTableFigure',
      insertTableFigure
    )
  );
}
// ==== texcloud table-figure end ====

// ==== texcloud pdf mode begin ====
async function downloadPdf(): Promise<void> {
  const doc = getActiveTexDocument();
  if (!doc) {
    return;
  }

  const rootUri = await getRootTexUri(doc);
  const rootDir = path.dirname(rootUri.fsPath);
  const rootBase = path.basename(rootUri.fsPath, path.extname(rootUri.fsPath));
  const pdfUri = vscode.Uri.file(path.join(rootDir, `${rootBase}.pdf`));

  try {
    await vscode.workspace.fs.stat(pdfUri);
  } catch {
    void vscode.window.showErrorMessage('PDF not found. Build first.');
    return;
  }

  try {
    await vscode.commands.executeCommand('revealInExplorer', pdfUri);
  } catch {}

  for (const command of ['explorer.download', 'filesExplorer.download']) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {}
  }

  void vscode.window.showInformationMessage(
    'PDF was revealed in Explorer. Use the Explorer download action if automatic download is unavailable.'
  );
}

type PdfPreviewMode = 'auto' | 'internal' | 'external';

function getPdfPreviewMode(): PdfPreviewMode {
  const value = vscode.workspace
    .getConfiguration('texcloud')
    .get<string>('pdfPreviewMode', 'auto');

  if (value === 'internal' || value === 'external' || value === 'auto') {
    return value;
  }
  return 'auto';
}

async function setPdfPreviewMode(): Promise<void> {
  const items = [
    { label: 'Auto', value: 'auto', description: 'Use existing automatic behavior' },
    { label: 'Internal', value: 'internal', description: 'Always open inside code-server' },
    { label: 'External', value: 'external', description: 'Always open in external browser' }
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose PDF preview mode'
  });

  if (!picked) {
    return;
  }

  await vscode.workspace
    .getConfiguration('texcloud')
    .update('pdfPreviewMode', picked.value, vscode.ConfigurationTarget.Workspace);

  void vscode.window.showInformationMessage(`PDF preview mode: ${picked.label}`);
}

async function openPdfInternal(pdfUri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', pdfUri, '', {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false,
    preserveFocus: true
  } as any);

  await restoreTocAfterPdfOpen();
}

async function openPdfExternal(externalUrl: string): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(externalUrl));
  await restoreTocAfterPdfOpen();
}
// ==== texcloud pdf mode end ====
