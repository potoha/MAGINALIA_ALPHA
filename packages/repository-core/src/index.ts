export {
  IDENTITY_PATH,
  REPOSITORY_KIND_LABELS,
  RepositoryError,
  createIdentity,
  isKnownRepositoryKind,
  parseIdentity,
  repositoryKindLabel,
  storageName,
  type RepositoryErrorCode,
  type RepositoryIdentity,
  type RepositoryKind
} from "./domain.js";
export { templateFiles, type TemplateOptions } from "./templates.js";
export {
  canonicalFolderMarkerFilename,
  isFolderMarkerUuid,
  parseFolderMarkerText,
  serializeFolderMarker,
  type FolderMarker,
  type FolderMarkerType
} from "./folder-marker.js";
