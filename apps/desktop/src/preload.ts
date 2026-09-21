import { contextBridge, ipcRenderer, webUtils } from "electron";
import { createMarkdownPreloadApi, type MarkdownEventSubscribe } from "./preload-api";

const subscribe: MarkdownEventSubscribe = (channel, listener) => {
  const onEvent = (_event: Electron.IpcRendererEvent, ...args: readonly unknown[]): void => {
    if (args.length !== 1) return;
    listener(args[0]);
  };
  ipcRenderer.on(channel, onEvent);
  return () => {
    ipcRenderer.removeListener(channel, onEvent);
  };
};

const api = createMarkdownPreloadApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  subscribe,
  (file) => webUtils.getPathForFile(file),
);

contextBridge.exposeInMainWorld("maginalia", api);
