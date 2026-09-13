import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import type { WritingSurface } from "./controller";

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

const MODEL_URI = monaco.Uri.parse("inmemory://maginalia/current.md");

export class MonacoMarkdownSurface implements WritingSurface {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly changeListeners = new Set<(text: string) => void>();
  private model: monaco.editor.ITextModel | undefined;
  private modelChangeSubscription: monaco.IDisposable | undefined;

  public constructor(container: HTMLElement) {
    this.editor = monaco.editor.create(container, {
      automaticLayout: true,
      fontSize: 16,
      minimap: { enabled: false },
      padding: { top: 16, bottom: 16 },
      scrollBeyondLastLine: false,
      wordWrap: "on"
    });
    this.replaceDocument("");
  }

  public replaceDocument(text: string): void {
    this.modelChangeSubscription?.dispose();
    this.model?.dispose();
    this.model = monaco.editor.createModel(text, "markdown", MODEL_URI);
    this.editor.setModel(this.model);
    this.modelChangeSubscription = this.model.onDidChangeContent(() => {
      const value = this.getText();
      for (const listener of this.changeListeners) listener(value);
    });
  }

  public getText(): string {
    return this.model?.getValue(monaco.editor.EndOfLinePreference.TextDefined, true) ?? "";
  }

  public appendTextForSmoke(text: string): void {
    const model = this.model;
    if (!model) return;

    const end = model.getFullModelRange().getEndPosition();
    model.pushEditOperations([], [{
      range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
      text
    }], () => null);
  }

  public onTextChange(listener: (text: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  public focus(): void {
    this.editor.focus();
  }

  public dispose(): void {
    this.modelChangeSubscription?.dispose();
    this.model?.dispose();
    this.editor.dispose();
    this.changeListeners.clear();
  }
}
