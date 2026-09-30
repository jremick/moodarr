import { createRoot } from 'react-dom/client';
import App from './App';
import { createMoodarrBridge } from './bridge';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Moodarr app root is missing.');
const bridge = createMoodarrBridge();
createRoot(root).render(<App bridge={bridge} />);
if (import.meta.hot) import.meta.hot.dispose(() => bridge.dispose());
