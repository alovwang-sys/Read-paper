import { createContext } from 'react';
import type { WorkspaceScope } from '../domain/types';

export const PaneContext = createContext<{ paneId: string; tabId: string; scope: WorkspaceScope } | undefined>(undefined);
export const RESOURCE_DRAG_MIME = 'application/x-papertrail-resource';
