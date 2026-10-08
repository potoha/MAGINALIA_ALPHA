export interface FolderIdentityRecoveryNotice {
  readonly title: string;
  readonly message: string;
  readonly canRepairWorkdesk: boolean;
}

export function projectIdentityRecoveryNotice(code: string): FolderIdentityRecoveryNotice {
  if (code === "marker-conflict") {
    return {
      title: "Projectの管理情報に競合があります",
      message: "複数の管理情報が見つかり、どれを使うか決められません。ファイルはそのまま利用できます。Workdeskへの登録には、管理情報の競合解消が必要です。",
      canRepairWorkdesk: false
    };
  }
  if (code === "wrong-type" || code === "legacy-kind-conflict") {
    return {
      title: "Projectの管理情報を確認できません",
      message: "このフォルダーの管理情報はProject用ではありません。ファイルはそのまま利用できます。正しい管理情報を確認するまで、Workdeskへの登録はできません。",
      canRepairWorkdesk: false
    };
  }
  return {
    title: "Projectの管理情報を確認できません",
    message: "Markdownや画像などのファイルはそのまま利用できます。Workdeskへの登録には、管理情報の修復が必要です。",
    canRepairWorkdesk: false
  };
}

export function workdeskIdentityRecoveryNotice(code: string): FolderIdentityRecoveryNotice {
  if (code === "marker-conflict") {
    return {
      title: "Workdeskの管理情報に競合があります",
      message: "読み取り可能なファイルはそのまま利用できます。Project一覧を使うには、管理情報の競合解消が必要です。",
      canRepairWorkdesk: false
    };
  }
  if (code === "legacy-kind-conflict") {
    return {
      title: "Workdeskの管理情報を確認できません",
      message: "このフォルダーには別の役割を示す管理情報があります。ファイルはそのまま利用できます。管理情報は変更していません。",
      canRepairWorkdesk: false
    };
  }
  return {
    title: "Workdeskの管理情報が見つかりません",
    message: "読み取り可能なファイルはそのまま利用できます。WorkdeskのProject一覧を使うには、管理情報の修復が必要です。",
    canRepairWorkdesk: true
  };
}
