import type TelemetryReporter from '@vscode/extension-telemetry';
import type { WebviewFns } from '../sqlite-viewer-core/src/file-system';
import type { WorkerFns, WorkerDB } from '../sqlite-viewer-core/src/worker-db';

import * as vsc from 'vscode';
import path from 'path';

import * as Caplink from "../sqlite-viewer-core/src/caplink";
import nodeEndpoint from "../sqlite-viewer-core/src/vendor/comlink/src/node-adapter";
import { WireEndpoint } from '../sqlite-viewer-core/src/vendor/postmessage-over-wire/comlinked'

import { Disposable, disposeAll } from './dispose';
import { IS_VSCODE, IS_VSCODIUM, WebviewCollection, WebviewStream, cspUtil, getUriParts } from './util';
import { Worker } from './webWorker';
import { VscodeFns } from './vscodeFns';
import { WorkerMeta } from './workerMeta';
// import type { Credentials } from './credentials';

//#region Pro
import { ConfigurationSection, ExtensionId, FullExtensionId } from './constants';
//#endregion

const pro__IsPro = false;

interface SQLiteEdit {
  readonly data: Uint8Array;
}

interface SQLiteDocumentDelegate {
  extensionUri: vsc.Uri;
  getFileData(): Promise<Uint8Array>;
}

function getConfiguredMaxFileSize() {
  const config = vsc.workspace.getConfiguration(ConfigurationSection);
  const maxFileSizeMB = config.get<number>('maxFileSize') ?? 200;
  const maxFileSize = maxFileSizeMB * 2 ** 20;
  return maxFileSize;
}

const TooLargeErrorMsg = "File too large. You can increase this limit in the settings under 'Sqlite Viewer: Max File Size'."

async function createWebWorker(
  extensionUri: vsc.Uri,
  _filename: string,
  _uri: vsc.Uri,
): Promise<WorkerMeta> {
  const workerPath = import.meta.env.BROWSER_EXT
    ? vsc.Uri.joinPath(extensionUri, 'out', 'worker-browser.js').toString()
    : path.resolve(__dirname, "./worker.js")

  const worker = new Worker(workerPath);
  const workerEndpoint = nodeEndpoint(worker);
  const workerFns = Caplink.wrap<WorkerFns>(workerEndpoint);

  return {
    workerFns,
    workerLike: worker,
    async importDbWrapper(xUri, filename) {
      const [data, walData] = await readFile(xUri);
      if (data == null) return { promise: Promise.reject(Error(TooLargeErrorMsg)) }
      const args = {
        data,
        walData,
        maxFileSize: getConfiguredMaxFileSize(),
        mappings: {
          'sqlite3.wasm': vsc.Uri.joinPath(extensionUri, 'sqlite-viewer-core', 'vscode', 'build', 'assets', 'sqlite3.wasm').toString(),
        },
        readOnly: true,
      };
      const transfer = [
        ...data ? [data.buffer as ArrayBuffer] : [],
        ...walData ? [walData.buffer as ArrayBuffer] : [],
      ];
      const workerDbPromise = workerFns.importDb(filename, Caplink.transfer(args, transfer));
      return { promise: workerDbPromise }
    }
  }
}

async function readFile(uri: vsc.Uri): Promise<[data: Uint8Array|null, walData?: Uint8Array|null]> {
  if (uri.scheme === 'untitled') {
    return [new Uint8Array(), null];
  }

  const maxFileSize = getConfiguredMaxFileSize();

  const walUri = uri.with({ path: uri.path + '-wal' })

  const stat = await vsc.workspace.fs.stat(uri)
  if (maxFileSize !== 0 && stat.size > maxFileSize)
    return [null, null];

  return Promise.all([
    vsc.workspace.fs.readFile(uri),
    vsc.workspace.fs.readFile(walUri).then(x => x, () => null)
  ]);
}

const pro__createTxikiWorker: () => never = () => { throw new Error("Not implemented") }

export class SQLiteDocument extends Disposable implements vsc.CustomDocument {
  static async create(
    openContext: vsc.CustomDocumentOpenContext,
    uri: vsc.Uri,
    delegate: SQLiteDocumentDelegate,
  ): Promise<SQLiteDocument> {

    const localMode = !vsc.env.remoteName;
    const remoteWorkspaceMode = !!vsc.env.remoteName && vsc.extensions.getExtension(FullExtensionId)?.extensionKind === vsc.ExtensionKind.Workspace;
    const canUseNativeSqlite3 = localMode || remoteWorkspaceMode;

    const createWorkerMeta = !import.meta.env.BROWSER_EXT && pro__IsPro && canUseNativeSqlite3 // Do not change this line
      ? pro__createTxikiWorker 
      : createWebWorker;

    // If we have a backup, read that. Otherwise read the resource from the workspace. XXX: This needs a review. When are we backing stuff up?
    const xUri = typeof openContext.backupId === 'string' ? vsc.Uri.parse(openContext.backupId) : uri;

    const { filename } = getUriParts(xUri);
    const workerMeta = await createWorkerMeta(delegate.extensionUri, filename, xUri);

    const { promise: workerDbPromise } = await workerMeta.importDbWrapper(uri, filename, delegate.extensionUri);

    workerDbPromise.catch(() => {}) // prevent unhandled rejection warning (caught elsewhere)

    return new SQLiteDocument(uri, delegate, workerMeta, workerDbPromise);
  }

  getConfiguredMaxFileSize() { return getConfiguredMaxFileSize() }

  private readonly _uri: vsc.Uri;
  private _edits: Array<SQLiteEdit> = [];
  private _savedEdits: Array<SQLiteEdit> = [];

  private readonly _delegate: SQLiteDocumentDelegate;

  private constructor(
    uri: vsc.Uri,
    private delegate: SQLiteDocumentDelegate,
    private readonly workerMeta: WorkerMeta,
    private workerDbPromise: Promise<Caplink.Remote<WorkerDB>>,
  ) {
    super();
    this._uri = uri;
    this._delegate = delegate;
  }

  public get uri() { return this._uri; }
  public get uriParts() { return getUriParts(this._uri); }

  private readonly _onDidDispose = this._register(new vsc.EventEmitter<void>());
  public readonly onDidDispose = this._onDidDispose.event;

  private readonly _onDidChangeDocument = this._register(new vsc.EventEmitter<{
    readonly content?: Uint8Array;
    readonly walContent?: Uint8Array|null;
    readonly edits: readonly SQLiteEdit[];
  }>());

  /**
   * Fired to notify webviews that the document has changed.
   */
  public readonly onDidChangeContent = this._onDidChangeDocument.event;

  private readonly _onDidChange = this._register(new vsc.EventEmitter<{
    readonly label: string,
    undo(): void,
    redo(): void,
  }>());

  /**
   * Fired to tell VS Code that an edit has occurred in the document.
   *
   * This updates the document's dirty indicator.
   */
  public readonly onDidChange = this._onDidChange.event;

  /**
   * Called by VS Code when there are no more references to the document.
   *
   * This happens when all editors for it have been closed.
   */
  dispose() {
    this.workerMeta.workerFns[Symbol.dispose]();
    this.workerMeta.workerLike.terminate();
    this._onDidDispose.fire();
    super.dispose();
  }

  /**
   * Called when the user edits the document in a webview.
   *
   * This fires an event to notify VS Code that the document has been edited.
   */
  makeEdit(edit: SQLiteEdit) {
    throw Error("Not implemented")
    // this._edits.push(edit);

    // this._onDidChange.fire({
    //   label: 'Stroke',
    //   undo: async () => {
    //     this._edits.pop();
    //     this._onDidChangeDocument.fire({
    //       edits: this._edits,
    //     });
    //   },
    //   redo: async () => {
    //     this._edits.push(edit);
    //     this._onDidChangeDocument.fire({
    //       edits: this._edits,
    //     });
    //   }
    // });
  }

  /**
   * Called by VS Code when the user saves the document.
   */
  async save(cancellation: vsc.CancellationToken): Promise<void> {
    throw Error("Not implemented")
    // await this.saveAs(this.uri, cancellation);
    // this._savedEdits = Array.from(this._edits);
  }

  /**
   * Called by VS Code when the user saves the document to a new location.
   */
  async saveAs(targetResource: vsc.Uri, cancellation: vsc.CancellationToken): Promise<void> {
    throw Error("Not implemented")
  }

  /**
   * Called by VS Code when the user calls `revert` on a document.
   */
  async revert(_cancellation: vsc.CancellationToken): Promise<void> {
    throw Error("Not implemented");
  }

  async getDb() {
    return this.workerDbPromise;
  }

  async refreshDb() {
    const { promise } = await this.workerMeta.importDbWrapper(this.uri, this.uriParts.filename);
    this.workerDbPromise = promise;
    return promise;
  }

  /**
   * Called by VS Code to backup the edited document.
   *
   * These backups are used to implement hot exit.
   */
  async backup(destination: vsc.Uri, cancellation: vsc.CancellationToken): Promise<vsc.CustomDocumentBackup> {
    throw Error("Not implemented")
    // await this.saveAs(destination, cancellation);

    // return {
    //   id: destination.toString(),
    //   delete: async () => {
    //     try {
    //       await vsc.workspace.fs.delete(destination);
    //     } catch {
    //       // noop
    //     }
    //   }
    // };
  }
}

export class SQLiteEditorProvider implements vsc.CustomEditorProvider<SQLiteDocument> {
  readonly webviews = new WebviewCollection();
  private readonly webviewRemotes = new Map<vsc.WebviewPanel, Caplink.Remote<WebviewFns>>
  private readonly hostFns = new Map<SQLiteDocument, VscodeFns>();

  constructor(
    readonly context: vsc.ExtensionContext, 
    readonly reporter: TelemetryReporter,
  ) {}

  async openCustomDocument(
    uri: vsc.Uri,
    openContext: vsc.CustomDocumentOpenContext,
    _token: vsc.CancellationToken
  ): Promise<SQLiteDocument> {

    const document = await SQLiteDocument.create(openContext, uri, {
      extensionUri: this.context.extensionUri,
      getFileData: async () => {
        throw Error("Not implemented")
      }
    });

    const listeners: vsc.Disposable[] = [];

    listeners.push(document.onDidChange(e => {
      // Tell VS Code that the document has been edited by the use.
      this._onDidChangeCustomDocument.fire({
        document,
        ...e,
      });
    }));

    listeners.push(document.onDidChangeContent(async e => {
      // Update all webviews when the document changes
      const { filename } = document.uriParts;
      for (const panel of this.webviews.get(document.uri)) {
        await this.webviewRemotes.get(panel)?.forceUpdate(filename);
      }
    }));

    this.hostFns.set(document, new VscodeFns(this, document));
    document.onDidDispose(() => {
      this.hostFns.delete(document);
      disposeAll(listeners)
    });

    return document;
  }

  async resolveCustomEditor(
    document: SQLiteDocument,
    webviewPanel: vsc.WebviewPanel,
    _token: vsc.CancellationToken
  ): Promise<void> {
    this.webviews.add(document.uri, webviewPanel);

    const webviewStream = new WebviewStream(webviewPanel);
    const webviewEndpoint = new WireEndpoint(webviewStream, document.uriParts.filename)
    webviewEndpoint.addEventListener('messageerror', ev => console.error(ev.data))
    webviewEndpoint.addEventListener('error', ev => console.error(ev.error))

    this.webviewRemotes.set(webviewPanel, Caplink.wrap(webviewEndpoint));
    Caplink.expose(this.hostFns.get(document)!, webviewEndpoint);

    webviewPanel.webview.options = {
      enableScripts: true,
    };
    webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

    webviewPanel.onDidDispose(() => {
      const webviewRemote = this.webviewRemotes.get(webviewPanel);
      if (webviewRemote) {
        this.webviewRemotes.delete(webviewPanel);
        webviewRemote[Symbol.dispose]();
      }
    });
  }

  private readonly _onDidChangeCustomDocument = new vsc.EventEmitter<vsc.CustomDocumentEditEvent<SQLiteDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  public saveCustomDocument(document: SQLiteDocument, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.save(cancellation);
  }

  public saveCustomDocumentAs(document: SQLiteDocument, destination: vsc.Uri, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.saveAs(destination, cancellation);
  }

  public revertCustomDocument(document: SQLiteDocument, cancellation: vsc.CancellationToken): Thenable<void> {
    return document.revert(cancellation);
  }

  public backupCustomDocument(document: SQLiteDocument, context: vsc.CustomDocumentBackupContext, cancellation: vsc.CancellationToken): Thenable<vsc.CustomDocumentBackup> {
    return document.backup(context.destination, cancellation);
  }

  private async getHtmlForWebview(webview: vsc.Webview): Promise<string> {
    const buildUri = vsc.Uri.joinPath(this.context.extensionUri, 'sqlite-viewer-core', 'vscode', 'build');
    const codiconsUri = vsc.Uri.joinPath(this.context.extensionUri, 'node_modules', 'codicons', 'dist', 'codicon.css');

    const assetAsWebviewUri = (x: string) => webview.asWebviewUri(vsc.Uri.joinPath(buildUri, x));

    const html = new TextDecoder().decode(await vsc.workspace.fs.readFile(
      vsc.Uri.joinPath(buildUri, 'index.html')
    ));

    const cspObj = {
      [cspUtil.defaultSrc]: [webview.cspSource],
      [cspUtil.scriptSrc]: [webview.cspSource, cspUtil.wasmUnsafeEval], 
      [cspUtil.styleSrc]: [webview.cspSource, cspUtil.inlineStyle],
      [cspUtil.imgSrc]: [webview.cspSource, cspUtil.data],
      [cspUtil.fontSrc]: [webview.cspSource],
      [cspUtil.childSrc]: [cspUtil.blob],
    };

    // Only set csp for hosts that are known to correctly set `webview.cspSource`
    const cspStr = IS_VSCODE || IS_VSCODIUM
      ? cspUtil.build(cspObj)
      : ''

    const preparedHtml = html
      .replace(/(href|src)="(\/[^"]*)"/g, (_, attr, url) => {
        return `${attr}="${assetAsWebviewUri(url)}"`;
      })
      .replace('<!--HEAD-->', `
        <meta http-equiv="Content-Security-Policy" content="${cspStr}">
        <link rel="stylesheet" href="${webview.asWebviewUri(codiconsUri)}" crossorigin/>
      `)
      .replace('<!--BODY-->', ``)

      return preparedHtml;
  }
}

const registerOptions = {
  webviewOptions: {
    // TODO: serialize state!?
    retainContextWhenHidden: true,
  },
  supportsMultipleEditorsPerDocument: true,
} satisfies Parameters<typeof vsc.window.registerCustomEditorProvider>[2];

export class SQLiteEditorDefaultProvider extends SQLiteEditorProvider {
  static viewType = `${ExtensionId}.view`;

  public static register(context: vsc.ExtensionContext, reporter: TelemetryReporter): vsc.Disposable {
    return vsc.window.registerCustomEditorProvider(
      SQLiteEditorDefaultProvider.viewType,
      new SQLiteEditorDefaultProvider(context, reporter),
      registerOptions);
  }
}

export class SQLiteEditorOptionProvider extends SQLiteEditorProvider {
  static viewType = `${ExtensionId}.option`;

  public static register(context: vsc.ExtensionContext, reporter: TelemetryReporter): vsc.Disposable {
    return vsc.window.registerCustomEditorProvider(
      SQLiteEditorOptionProvider.viewType,
      new SQLiteEditorOptionProvider(context, reporter),
      registerOptions);
  }
}

