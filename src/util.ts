import * as vsc from 'vscode';
import type { TypedEventListenerOrEventListenerObject } from "@worker-tools/typed-event-target";

export function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class WebviewCollection {
  private readonly _webviews = new Set<{
    readonly resource: string;
    readonly webviewPanel: vsc.WebviewPanel;
  }>();

  public *get(uri: vsc.Uri): IterableIterator<vsc.WebviewPanel> {
    const key = uri.toString();
    for (const entry of this._webviews) {
      if (entry.resource === key) {
        yield entry.webviewPanel;
      }
    }
  }

  public has(uri: vsc.Uri): boolean {
    return !this.get(uri).next().done;
  }

  public add(uri: vsc.Uri, webviewPanel: vsc.WebviewPanel) {
    const entry = { resource: uri.toString(), webviewPanel };
    this._webviews.add(entry);

    webviewPanel.onDidDispose(() => {
      this._webviews.delete(entry);
    });
  }
}

/**
 * A wrapper for a vscode webview that implements Comlink's endpoint interface
 */
export class WebviewEndpointAdapter {
  constructor(private readonly webview: vsc.Webview) {}
  #disposables = new Map<TypedEventListenerOrEventListenerObject<MessageEvent>, vsc.Disposable>
  postMessage(message: any, transfer: Transferable[]) {
    // @ts-expect-error: transferables type missing
    this.webview.postMessage(message, transfer);
  }
  addEventListener(_event: "message", handler: TypedEventListenerOrEventListenerObject<MessageEvent>|null) {
    if (typeof handler === "function") {
      this.#disposables.set(handler, this.webview.onDidReceiveMessage(data => {
        handler(new MessageEvent("message", { data })); // FIXME: use faster custom messageevent impl
      }))
    } else if (handler) {
      this.#disposables.set(handler, this.webview.onDidReceiveMessage(data => {
        handler.handleEvent(new MessageEvent("message", { data }));
      }));
    }
  }
  removeEventListener(_event: "message", handler: TypedEventListenerOrEventListenerObject<MessageEvent>|null) {
    handler && this.#disposables.get(handler)?.dispose();
    handler && this.#disposables.delete(handler);
  }
}
