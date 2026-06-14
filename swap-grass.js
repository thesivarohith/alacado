const fs = require('fs');

const indexHtml = fs.readFileSync('index.html', 'utf-8');
const testHtml = fs.readFileSync('test.html', 'utf-8');

// 1. Extract Settings Panel CSS from test.html
const cssRegex = /\/\* ── Settings Panel ── \*\/(.*?)<\/style>/s;
const cssMatch = testHtml.match(cssRegex);
const settingsCss = cssMatch ? '/* ── Settings Panel ── */\n' + cssMatch[1] : '';

// 2. Extract Settings Panel HTML
const htmlRegex = /(<button class="settings-gear".*?<div class="settings-panel" id="settingsPanel"><\/div>)/s;
const htmlMatch = testHtml.match(htmlRegex);
const settingsHtml = htmlMatch ? htmlMatch[1] : '';

// 3. Extract the entire WebGPU module script from test.html
const scriptRegex = /(<script type="module">.*?)<\/body>/s;
const scriptMatch = testHtml.match(scriptRegex);
let newScript = scriptMatch ? scriptMatch[1] : '';

// --- Modifications to the new script ---
// 3a. Update scrolling logic to use .home-content-scroll instead of window
newScript = newScript.replace(
    /const scrollTop = window\.pageYOffset \|\| document\.documentElement\.scrollTop;\s*const docHeight = document\.documentElement\.scrollHeight;\s*const winHeight = window\.innerHeight;/g,
    `const scrollContainer = document.querySelector('.home-content-scroll');
      if (!scrollContainer) return 0;
      const scrollTop = scrollContainer.scrollTop;
      const docHeight = scrollContainer.scrollHeight;
      const winHeight = scrollContainer.clientHeight;`
);

newScript = newScript.replace(
    /const docHeight = document\.documentElement\.scrollHeight;\s*const winHeight = window\.innerHeight;/g,
    `const scrollContainer = document.querySelector('.home-content-scroll');
      if (!scrollContainer) return;
      const docHeight = scrollContainer.scrollHeight;
      const winHeight = scrollContainer.clientHeight;`
);

// 3b. Update cameraPath stages to match ALACADO's 4 stages
const newCameraPath = `
        const stageNames = ['Hero', 'Command Node', 'The Protocol', 'The Crossroads'];
        const cameraPath = [
            [0.00, -2.8,  7.2, 19.6,  0.5, 1.5,  0.4, 22.0, 1, 1, 10.0, 12.5, 5.0, 1.0, 40.0],  // Hero
            [0.33,  0,    2.2, 14.0,  0,  -2.0,   0,   15.0, 1, 1,  8.0, 10.0, 5.0, 1.0, 30.0],  // Command Node
            [0.66,  7.5, 10.9, 15.8,  0,   0.0,   0.7, 10.0, 1, 1,  6.0,  8.0, 5.0, 0.5, 20.0],  // Protocol
            [1.00,  0,   15.0,  0.0, -5,   3.0,  -5,    9.8, 1, 1, 13.8,  0.0, 17.5, 1.2,  9.0],  // Footer
        ];
`;
// We will replace the original cameraPath declaration
newScript = newScript.replace(/const stageNames = .*?\];/s, newCameraPath);
newScript = newScript.replace(/const cameraPath = \[.*?\];/s, '');

// Also replace the exported overrides array length to match 4
const newOverrides = `
            const exported = [
                { bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78 },
                { bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78 },
                { bladeBaseR:0, bladeBaseG:0.05, bladeBaseB:0.12, bladeTipR:0.75, bladeTipG:0.92, bladeTipB:0.97 },
                { fogStart:2, fogEnd:10, bladeHeight:2, bladeHeightVar:0, bladeLean:0, windSpeed:1.3, windAmplitude:0.21, bladeBaseR:0, bladeBaseG:0.028, bladeBaseB:0.07, bladeTipR:0.05, bladeTipG:0.35, bladeTipB:0.50 }
            ];
`;
newScript = newScript.replace(/const exported = \[.*?\];/s, newOverrides);

// Remove GSAP scroll event listeners (the new engine listens to window, we need to listen to home-content-scroll)
newScript = newScript.replace(
    /window\.addEventListener\('scroll', \(\) => { _scrollDirty = true; }, { passive: true }\);/g,
    `document.querySelector('.home-content-scroll').addEventListener('scroll', () => { _scrollDirty = true; }, { passive: true });`
);

// --- Apply modifications to index.html ---
let newIndexHtml = indexHtml;

// Remove GSAP CDN links
newIndexHtml = newIndexHtml.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.12\.5\/gsap\.min\.js"><\/script>\n\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.12\.5\/ScrollTrigger\.min\.js"><\/script>/g, '');

// Insert settings CSS right before </style>
newIndexHtml = newIndexHtml.replace('</style>', settingsCss + '\n</style>');

// Insert settings HTML right after <body>
newIndexHtml = newIndexHtml.replace('<body>', '<body>\n' + settingsHtml + '\n<div class="progress-bar" id="progressBar" style="position:fixed;top:0;left:0;height:2px;background:rgba(80,220,240,0.6);z-index:200;width:0;transition:width 0.1s linear;"></div>');

// Add data-stage attributes to the React components
newIndexHtml = newIndexHtml.replace(
    /<div class="hero-container">/g, 
    `<div class="hero-container section" data-stage="0">`
);
newIndexHtml = newIndexHtml.replace(
    /<section className="relative w-full min-h-screen bg-transparent flex flex-col items-center justify-center px-8 py-32 z-20" style={{ pointerEvents: 'auto' }}>/g,
    `<section className="relative w-full min-h-screen bg-transparent flex flex-col items-center justify-center px-8 py-32 z-20 section" data-stage="1" style={{ pointerEvents: 'auto' }}>`
);
newIndexHtml = newIndexHtml.replace(
    /<section className="w-full min-h-screen bg-transparent text-white flex flex-col items-center justify-center px-8 py-32 z-20">/g,
    `<section className="w-full min-h-screen bg-transparent text-white flex flex-col items-center justify-center px-8 py-32 z-20 section" data-stage="2">`
);
newIndexHtml = newIndexHtml.replace(
    /<footer className="w-full h-\[60vh\] bg-transparent flex flex-col items-center justify-center px-8 border-t border-white\/5 relative z-20">/g,
    `<footer className="w-full h-[60vh] bg-transparent flex flex-col items-center justify-center px-8 border-t border-white/5 relative z-20 section" data-stage="3">`
);

// Strip out the entire old <script type="module">...</script>
newIndexHtml = newIndexHtml.replace(/<script type="module">.*?<\/script>\s*<\/body>/s, '');

// Append the new script
newIndexHtml = newIndexHtml + newScript + '\n</body>\n</html>';

fs.writeFileSync('index.html', newIndexHtml);
console.log('Successfully swapped grass engine!');
