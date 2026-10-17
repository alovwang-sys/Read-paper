import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import './ui/styles.css';
import { installDesktopLifecycle } from './services/desktop';
import { installProjectFileSync } from './services/project-files';

installProjectFileSync();
installDesktopLifecycle();
createRoot(document.getElementById('root')!).render(<App />);
