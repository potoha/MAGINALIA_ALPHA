export interface SecureWebPreferences {
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  preload: string;
}

export function createSecureWebPreferences(preload: string): SecureWebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload
  };
}
