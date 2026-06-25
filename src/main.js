import './style.css';
import * as THREE from 'three';
import gsap from 'gsap';

let targetTexture;
let targetAspect = 1.0;
const loadedTextures = [];
const imageAspects = [];

let currentZoomIndex = 3;
let isAnimating = false;
let currentGridCenter = new THREE.Vector3(0, 0, 0);
let currentZoomLevels = [];
let zoomPath = [];
let currentGrid;
const gridStack = [];

// Scene Setup
const container = document.getElementById('app');
const scene = new THREE.Scene();

// Camera
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.0001, 20000);

// Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setClearColor(0x000000, 1.0);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
container.appendChild(renderer.domElement);

const vertexShader = `
  varying vec2 vUv;
  varying vec2 vTargetUv;

  uniform vec2 uBoundsMin;
  uniform vec2 uBoundsSize;
  uniform vec2 uUvScale;

  void main() {
    vUv = uv;
    vec4 worldPos = instanceMatrix * vec4(position, 1.0);
    
    // Normalize world position to 0-1 range based on layout bounds for target illustration mapping
    vec2 targetUv = (worldPos.xy - uBoundsMin) / uBoundsSize;
    
    // Object-fit: cover scaling
    vTargetUv = (targetUv - 0.5) * uUvScale + 0.5;
    
    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  varying vec2 vTargetUv;

  uniform sampler2D uTexture;
  uniform sampler2D uTargetTexture;
  uniform float uTintOpacity;

  float getLuminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
  }

  vec3 blendHardLight(vec3 base, vec3 blend) {
    return mix(
      2.0 * base * blend,
      1.0 - 2.0 * (1.0 - base) * (1.0 - blend),
      step(0.5, blend)
    );
  }

  void main() {
    vec4 texColor = texture2D(uTexture, vUv);
    
    // Safety clamp to avoid sampling outside bounds
    vec2 safeTargetUv = clamp(vTargetUv, 0.0, 1.0);
    vec4 targetColor = texture2D(uTargetTexture, safeTargetUv);
    
    // Treat the instanced photo purely as a grayscale texture map
    float photoLum = getLuminance(texColor.rgb);
    vec3 grayscalePhoto = vec3(photoLum);
    
    // Hard Light Blend: The target color dictates the lighting.
    vec3 illusionColor = blendHardLight(grayscalePhoto, targetColor.rgb);
    
    // Mix the hard-light composite back with the pure target color slightly
    // to enforce the exact hue and saturation.
    illusionColor = mix(illusionColor, targetColor.rgb, 0.6);
    
    // Final zoom opacity mix
    gl_FragColor = vec4(mix(texColor.rgb, illusionColor, uTintOpacity), 1.0);
  }
`;

class PhotoGrid {
  constructor(center, width, height, densityRows, excludeImageIndices = [], initialOpacity = 0.0) {
    this.center = center;
    this.width = width;
    this.height = height;
    this.meshes = [];
    this.uTintOpacity = { value: initialOpacity };
    
    let availableIndices = loadedTextures.map((_, i) => i).filter(i => !excludeImageIndices.includes(i));
    if (availableIndices.length === 0) {
      availableIndices = loadedTextures.map((_, i) => i);
      zoomPath = []; // Reset history (safety fallback)
    }

    const targetRowHeight = height / densityRows;
    const rowsData = [];
    let currentRow = [];
    let currentRowWidth = 0;
    let currentY = height / 2;

    // Flickr-style packing
    while (currentY > -height / 2) {
      const texGroupIndex = Math.floor(Math.random() * availableIndices.length);
      const globalTexIndex = availableIndices[texGroupIndex];
      const aspect = imageAspects[globalTexIndex];
      
      currentRow.push({ index: globalTexIndex, aspect: aspect });
      currentRowWidth += aspect * targetRowHeight;
      
      if (currentRowWidth >= width) {
        const scale = width / currentRowWidth;
        const finalRowHeight = targetRowHeight * scale;
        
        let currentX = -width / 2;
        for (let i = 0; i < currentRow.length; i++) {
          const item = currentRow[i];
          let itemWidth = item.aspect * finalRowHeight;
          
          if (i === currentRow.length - 1) {
            itemWidth = (width / 2) - currentX; // Force perfectly flush on right edge
          }
          
          item.w = itemWidth;
          item.h = finalRowHeight;
          item.cx = currentX + itemWidth / 2;
          item.cy = currentY - finalRowHeight / 2;
          
          currentX += itemWidth;
        }
        
        rowsData.push(currentRow);
        currentY -= finalRowHeight;
        currentRow = [];
        currentRowWidth = 0;
      }
    }

    const texturePositions = loadedTextures.map(() => []);
    rowsData.forEach(row => {
      row.forEach(item => {
        texturePositions[item.index].push(item);
      });
    });

    const geometry = new THREE.PlaneGeometry(1, 1);
    const boundsMin = new THREE.Vector2(center.x - width / 2, center.y - height / 2);
    const boundsSize = new THREE.Vector2(width, height);
    
    const boundsAspect = width / height;
    const uvScale = new THREE.Vector2(1.0, 1.0);
    if (boundsAspect > targetAspect) {
        uvScale.y = targetAspect / boundsAspect;
    } else {
        uvScale.x = boundsAspect / targetAspect;
    }

    texturePositions.forEach((positions, texIndex) => {
      if (positions.length === 0) return;
      
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uTexture: { value: loadedTextures[texIndex] },
          uTargetTexture: { value: targetTexture },
          uTintOpacity: this.uTintOpacity,
          uBoundsMin: { value: boundsMin },
          uBoundsSize: { value: boundsSize },
          uUvScale: { value: uvScale }
        }
      });

      const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
      const dummy = new THREE.Object3D();
      
      positions.forEach((pos, i) => {
        dummy.position.set(center.x + pos.cx, center.y + pos.cy, center.z);
        dummy.scale.set(pos.w, pos.h, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData = { isGrid: true, texIndex: texIndex };
      this.meshes.push(mesh);
      scene.add(mesh);
    });
  }

  destroy() {
    this.meshes.forEach(mesh => {
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
      if (typeof mesh.dispose === 'function') mesh.dispose();
    });
    this.meshes = [];
  }
}

function calculateZoomLevels(width, height) {
  const fovRad = THREE.MathUtils.degToRad(camera.fov / 2);
  const zFitHeight = height / (2 * Math.tan(fovRad));
  const zFitWidth = (width / camera.aspect) / (2 * Math.tan(fovRad));
  const maxZ = Math.max(zFitHeight, zFitWidth);
  
  return [
    maxZ * 0.05, // Super close
    maxZ * 0.25,
    maxZ * 0.5,
    maxZ         // Macro
  ];
}

async function init() {
  const tl = new THREE.TextureLoader();
  targetTexture = await tl.loadAsync('/images/target-illustration.jpg');
  targetTexture.colorSpace = THREE.SRGBColorSpace;
  targetAspect = targetTexture.image.width / targetTexture.image.height;
  
  // Dynamic Image Import using Vite glob
  const imageModules = import.meta.glob('../public/images/*.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' });
  const allUrls = Object.values(imageModules);
  const sourceUrls = allUrls.filter(url => !url.includes('target-illustration'));
  
  for (let url of sourceUrls) {
    const tex = await tl.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    loadedTextures.push(tex);
    imageAspects.push(tex.image.width / tex.image.height);
  }

  // Mobile-first: base container width on viewport
  const baseWidth = 100;
  const baseHeight = baseWidth / camera.aspect;
  
  currentGridCenter = new THREE.Vector3(0, 0, 0);
  // Create massive macro view (150 rows) for high density
  currentGrid = new PhotoGrid(currentGridCenter, baseWidth, baseHeight, 150, [], 1.0);
  gridStack.push(currentGrid);
  
  currentZoomLevels = calculateZoomLevels(baseWidth, baseHeight);
  currentZoomIndex = 3;
  camera.position.z = currentZoomLevels[currentZoomIndex];
  
  animate();
}

window.addEventListener('wheel', (e) => {
  if (isAnimating) return;
  
  if (e.deltaY > 0 && currentZoomIndex < currentZoomLevels.length - 1) {
    currentZoomIndex++;
    animateToZoomLevel(currentZoomIndex);
  } else if (e.deltaY < 0 && currentZoomIndex > 0) {
    currentZoomIndex--;
    animateToZoomLevel(currentZoomIndex);
  }
});

function animateToZoomLevel(index) {
  isAnimating = true;
  const targetZ = currentGridCenter.z + currentZoomLevels[index];
  const targetOpacity = index === currentZoomLevels.length - 1 ? 1.0 : 0.0;

  gsap.to(camera.position, {
    z: targetZ,
    duration: 1.5,
    ease: "power2.inOut",
    onComplete: () => { isAnimating = false; }
  });

  // Animate the opacity of the current global master grid (gridStack[0])
  if (gridStack.length > 0 && currentGrid === gridStack[0]) {
    gsap.to(gridStack[0].uTintOpacity, {
      value: targetOpacity,
      duration: 1.5,
      ease: "power2.inOut"
    });
  }
}

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener('click', (e) => {
  if (isAnimating) return;

  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(currentGrid.meshes);

  if (intersects.length > 0) {
    const intersect = intersects[0];
    const instanceId = intersect.instanceId;
    const mesh = intersect.object;
    const texIndex = mesh.userData.texIndex;

    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(instanceId, matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);

    zoomIntoPortal(position, scale.x, scale.y, texIndex);
  }
});

function zoomIntoPortal(targetPos, w, h, textureIndex) {
  if (isAnimating) return;
  isAnimating = true;
  
  try {
    zoomPath.push(textureIndex);

    // Check if we've exhausted the unique unseen images pool
    const isLoopPortal = zoomPath.length >= loadedTextures.length - 1;
    console.log(`[Deep Zoom] Portal Clicked. zoomPath length: ${zoomPath.length}, isLoopPortal: ${isLoopPortal}`);

    // New grid is strictly inside the bounds of the clicked image
    // Placed slightly in front (+z) to occlude the parent image
    const newCenter = new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z + 0.001);
    let nextGrid;
    
    let gridW = w;
    let gridH = h;

    if (isLoopPortal) {
      // Infinite Loop Trigger: Create the Miniature Master Grid!
      const camAspect = camera.aspect;
      if (w / h > camAspect) {
        gridH = w / camAspect;
      } else {
        gridW = h * camAspect;
      }
      console.log(`[Deep Zoom] Spawning Miniature Master Grid at size: ${gridW}x${gridH}`);
      nextGrid = new PhotoGrid(newCenter, gridW, gridH, 150, [], 1.0);
    } else {
      // Normal deep zoom exploration
      nextGrid = new PhotoGrid(newCenter, w, h, 20, zoomPath, 0.0);
    }
    
    gridStack.push(nextGrid);
    currentGrid = nextGrid;

    currentGridCenter.copy(newCenter);
    currentZoomLevels = calculateZoomLevels(gridW, gridH);
    
    // If looping, we animate perfectly into the newly spawned macro view.
    currentZoomIndex = 3; 
    const targetCameraZ = currentGridCenter.z + currentZoomLevels[3];
    
    console.log(`[Deep Zoom] Animating camera to Z: ${targetCameraZ}`);

    gsap.to(camera.position, {
      x: currentGridCenter.x,
      y: currentGridCenter.y,
      z: targetCameraZ,
      duration: 2,
      ease: "power3.inOut",
      onComplete: () => {
        try {
          if (isLoopPortal) {
            console.log(`[Deep Zoom] Animation complete. Triggering instant Teleport...`);
            
            // THE TELEPORT: Instantly and silently snap back to the Global Master Grid
            const rootGrid = gridStack[0];
            currentGrid = rootGrid;
            currentGridCenter.copy(rootGrid.center);
            currentZoomLevels = calculateZoomLevels(rootGrid.width, rootGrid.height);
            currentZoomIndex = 3;
            
            camera.position.set(currentGridCenter.x, currentGridCenter.y, currentGridCenter.z + currentZoomLevels[3]);
            
            // Memory Cleanup: Destroy all intermediate fractal grids
            console.log(`[Deep Zoom] Cleaning up ${gridStack.length - 1} nested grids from memory.`);
            for (let i = 1; i < gridStack.length; i++) {
              if (gridStack[i] && typeof gridStack[i].destroy === 'function') {
                gridStack[i].destroy();
              }
            }
            gridStack.length = 1; // Preserve root grid
            zoomPath = [];
            console.log(`[Deep Zoom] Teleport complete. Memory cleaned.`);
          }
        } catch (e) {
          console.error(`[Deep Zoom] Error during onComplete teleport/cleanup:`, e);
        } finally {
          isAnimating = false;
        }
      }
    });
  } catch (err) {
    console.error(`[Deep Zoom] Fatal error in zoomIntoPortal:`, err);
    isAnimating = false;
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// Start app
init().catch(console.error);
