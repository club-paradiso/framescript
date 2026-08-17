import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Options } from './Options';
import '../styles/base.css';
import './options.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Options />
    </StrictMode>,
  );
}
