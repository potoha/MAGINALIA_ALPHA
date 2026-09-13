import { contextBridge, ipcRenderer } from "electron";
import { createMarkdownPreloadApi } from "./preload-api";

const api = createMarkdownPreloadApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));

contextBridge.exposeInMainWorld("maginalia", api);
