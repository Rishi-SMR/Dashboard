/** Side-effect CSS imports. Without this, `import './x.css'` is a TS2882 error;
 *  the project carried one for cashflow.css as a standing baseline. */
declare module '*.css';
