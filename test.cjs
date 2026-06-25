const puppeteer = require('puppeteer');

const delay = ms => new Promise(res => setTimeout(res, ms));

(async () => {
  try {
    const browser = await puppeteer.launch({headless: true});
    const page = await browser.newPage();
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
    
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle2' });
    await delay(2000);
    
    // Inject a global function to get a clickable coordinate
    await page.evaluate(() => {
      window.getClickableCoordinate = () => {
        if (!window.currentGrid || !window.camera || !window.renderer) return null;
        
        // Find an instance in the current grid
        const mesh = window.currentGrid.meshes[0]; // just use the first mesh
        if (!mesh) return null;
        
        const matrix = new window.THREE.Matrix4();
        mesh.getMatrixAt(0, matrix); // Get first instance
        const position = new window.THREE.Vector3();
        position.setFromMatrixPosition(matrix);
        
        // Project to 2D screen coordinates
        position.project(window.camera);
        
        const widthHalf = window.innerWidth / 2;
        const heightHalf = window.innerHeight / 2;
        
        return {
          x: (position.x * widthHalf) + widthHalf,
          y: -(position.y * heightHalf) + heightHalf
        };
      };
    });
    
    for (let i = 0; i < 22; i++) {
      const coord = await page.evaluate(() => window.getClickableCoordinate());
      if (coord) {
        console.log('Clicking', coord.x, coord.y);
        await page.mouse.click(coord.x, coord.y);
      } else {
        console.log('Could not find clickable coordinate');
      }
      await delay(2500);
    }
    
    await browser.close();
  } catch (err) {
    console.log('TEST SCRIPT ERROR:', err);
  }
})();
