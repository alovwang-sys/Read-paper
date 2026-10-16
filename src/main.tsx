import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import './ui/styles.css';
import { installDesktopLifecycle } from './services/desktop';

installDesktopLifecycle();
createRoot(document.getElementById('root')!).render(<App />);
