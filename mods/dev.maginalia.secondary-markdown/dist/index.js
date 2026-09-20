/**
 * First-party proof Mod for the D.5 Mod boundary.
 *
 * The host owns placement policy.  In the temporary single-placement mode a
 * document already open in the central editor is rejected by the semantic
 * open-document-view capability and the command returns that harmless result.
 */
export function activate(api) {
  api.registerView({
    id: "secondary-markdown",
    title: "Secondary Markdown",
    region: "secondary",
    groupId: "sidebar-group-1"
  });

  api.registerCommand(
    {
      id: "open-active-document-in-secondary",
      title: "Open Active Markdown in Secondary Pane"
    },
    async () => {
      const active = await api.getActiveDocument();
      if (active === null) {
        return {
          kind: "unavailable",
          code: "no-active-document",
          message: "Open a Markdown document before opening a secondary view."
        };
      }
      return api.openDocumentView({
        documentId: active.documentId,
        viewType: "markdown",
        region: "secondary",
        groupId: "sidebar-group-1"
      });
    }
  );
}
