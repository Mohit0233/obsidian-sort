const fe = app.workspace.getLeavesOfType('file-explorer')[0].view;
const p = app.plugins.getPlugin('folder-sort-by-created');
const rootFolder = app.vault.getRoot();
const sorted = fe.getSortedFolderItems(rootFolder);
const result = sorted.filter(item => item.file.children).map(item => ({
  path: item.file.path.slice(0, 45),
  ctime: new Date(p.folderCtimeCache.get(item.file.path) || 0).toISOString().slice(0, 16)
}));
JSON.stringify(result.slice(0, 5).concat(['...'], result.slice(-3)), null, 2);
