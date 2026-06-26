import './style.css';
import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Configuration
const SCALE_FACTOR = 0.005; // Extreme micro-scaling for nested layers
const GRID_ROWS = 150;
const BASE_CAMERA_Z = 12;

// State
let loadedTextures = [];
let imageAspects = [];
let targetTexture = null;
let targetAspect = 1.0;
let currentGrid = null;
let sequenceLayers = [];

// Scene Setup
const container = document.getElementById('app');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.00001, 100000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, logarithmicDepthBuffer: true });
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
    vec2 targetUv = (worldPos.xy - uBoundsMin) / uBoundsSize;
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

  float getLuminance(vec3 color) { return dot(color, vec3(0.299, 0.587, 0.114)); }
  vec3 blendHardLight(vec3 base, vec3 blend) {
    return mix(
      2.0 * base * blend,
      1.0 - 2.0 * (1.0 - base) * (1.0 - blend),
      step(0.5, blend)
    );
  }

  void main() {
    vec4 texColor = texture2D(uTexture, vUv);
    vec2 safeTargetUv = clamp(vTargetUv, 0.0, 1.0);
    vec4 targetColor = texture2D(uTargetTexture, safeTargetUv);
    
    float photoLum = getLuminance(texColor.rgb);
    vec3 grayscalePhoto = vec3(photoLum);
    vec3 illusionColor = blendHardLight(grayscalePhoto, targetColor.rgb);
    illusionColor = mix(illusionColor, targetColor.rgb, 0.6);
    
    gl_FragColor = vec4(mix(texColor.rgb, illusionColor, uTintOpacity), 1.0);
  }
`;

class PhotoGrid {
  constructor(center, width, height, densityRows) {
    this.center = center;
    this.width = width;
    this.height = height;
    this.meshes = [];
    this.uTintOpacity = { value: 1.0 };
    
    const availableIndices = loadedTextures.map((_, i) => i);
    const targetRowHeight = height / densityRows;
    const rowsData = [];
    let currentRow = [];
    let currentRowWidth = 0;
    let currentY = height / 2;

    while (currentY > -height / 2) {
      const globalTexIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
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
          if (i === currentRow.length - 1) itemWidth = (width / 2) - currentX; 
          
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
    rowsData.forEach(row => row.forEach(item => texturePositions[item.index].push(item)));

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
        },
        depthWrite: true,
        depthTest: true
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
      mesh.userData = { isGrid: true, texIndex: texIndex, positions: positions };
      this.meshes.push(mesh);
      scene.add(mesh);
    });
  }
}

async function init() {
  const tl = new THREE.TextureLoader();
  
  // Dynamic Image Import using Vite glob
  const imageModules = import.meta.glob('../public/images/*.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' });
  const allUrls = Object.values(imageModules);
  
  // Load target illustration
  const targetUrl = allUrls.find(url => url.includes('target-illustration'));
  if (targetUrl) {
    targetTexture = await tl.loadAsync(targetUrl);
    targetTexture.colorSpace = THREE.SRGBColorSpace;
    targetAspect = targetTexture.image.width / targetTexture.image.height;
  }
  
  // Load source images
  const sourceUrls = allUrls.filter(url => !url.includes('target-illustration')).sort();
  for (let url of sourceUrls) {
    const tex = await tl.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    loadedTextures.push(tex);
    imageAspects.push(tex.image.width / tex.image.height);
  }

  if (loadedTextures.length === 0) return;

  const baseWidth = 100;
  const baseHeight = baseWidth / (window.innerWidth / window.innerHeight);
  
  // Level 0: Grid Mosaic
  currentGrid = new PhotoGrid(new THREE.Vector3(0, 0, 0), baseWidth, baseHeight, GRID_ROWS);
  
  // Find a portal photo close to the center
  let bestDistance = Infinity;
  let portalPos = new THREE.Vector3();
  let portalScale = new THREE.Vector3();
  
  // We need to parse instance matrices
  const dummyMatrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  
  currentGrid.meshes.forEach(mesh => {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, dummyMatrix);
      dummyMatrix.decompose(position, quaternion, scale);
      
      const dist = position.distanceTo(new THREE.Vector3(0, 0, 0));
      if (dist < bestDistance) {
        bestDistance = dist;
        portalPos.copy(position);
        portalScale.copy(scale);
      }
    }
  });

  // Level 1+: Sequential Z-Stack behind Portal
  let currentX = portalPos.x;
  let currentY = portalPos.y;
  
  for (let i = 0; i < loadedTextures.length; i++) {
    const tex = loadedTextures[i];
    
    // The first layer in the sequence must perfectly cover the grid photo
    // We render the sequence layer slightly in front of the grid (Z=0.001) so it occludes the grid photo smoothly.
    let layerScaleMultiplier = Math.pow(SCALE_FACTOR, i);
    let currentWidth = portalScale.x * layerScaleMultiplier;
    let currentHeight = portalScale.y * layerScaleMultiplier;
    
    if (i > 0) {
      const prevScaleMult = Math.pow(SCALE_FACTOR, i - 1);
      const prevWidth = portalScale.x * prevScaleMult;
      const prevHeight = portalScale.y * prevScaleMult;
      
      const maxOffsetX = (prevWidth - currentWidth) / 2 * 0.7; 
      const maxOffsetY = (prevHeight - currentHeight) / 2 * 0.7;
      
      const randX = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 2 - 1;
      const randY = (Math.sin(i * 78.233) * 43758.5453 % 1) * 2 - 1;
      
      currentX += randX * maxOffsetX;
      currentY += randY * maxOffsetY;
    }
    
    const geometry = new THREE.PlaneGeometry(currentWidth, currentHeight);
    const material = new THREE.MeshBasicMaterial({ 
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: i === 0 ? 1.0 : 0.0 
    });
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(currentX, currentY, 0.001); 
    mesh.renderOrder = 10 + i; // Sequence renders on top of grid
    
    scene.add(mesh);
    
    sequenceLayers.push({
      mesh: mesh,
      x: currentX,
      y: currentY,
      width: currentWidth,
      index: i
    });
  }

  // Create GSAP ScrollTrigger Timeline
  setupScrollTimeline(portalPos);

  animate();
}

function setupScrollTimeline(portalPos) {
  // Setup a proxy object to hold our animated camera properties
  const camState = {
    z: BASE_CAMERA_Z,
    x: 0,
    y: 0,
    zoomLevel: 0 // sequence zoom level
  };
  
  camera.position.set(0, 0, BASE_CAMERA_Z);

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: ".scroll-container",
      start: "top top",
      end: "bottom bottom",
      scrub: 0.5, // Smooth scrubbing
    }
  });

  // Phase 1 -> 2: Fade out illusion, move closer to grid
  tl.to(currentGrid.uTintOpacity, {
    value: 0.0,
    ease: "none",
    duration: 1
  }, 0);
  
  tl.to(camState, {
    z: 2.0, // Move closer to grid
    ease: "power2.in",
    duration: 1
  }, 0);

  // Phase 2 -> 3: Interpolate X/Y to aim perfectly at the portal
  tl.to(camState, {
    x: portalPos.x,
    y: portalPos.y,
    ease: "power2.inOut",
    duration: 1
  }, 1);
  
  tl.to(camState, {
    z: 0.5, // Even closer to portal
    ease: "none",
    duration: 1
  }, 1);

  // Phase 3 -> 4: Dive into the Infinite Z-Stack sequence
  // The sequence has N layers. We map timeline progress to `zoomLevel`.
  tl.to(camState, {
    zoomLevel: sequenceLayers.length - 1,
    ease: "none",
    duration: 3 // Takes up the majority of the scroll space
  }, 2);
  
  // Use GSAP's onUpdate to calculate exponential Z and sequence X/Y
  tl.eventCallback("onUpdate", () => {
    // If we are past Phase 2, calculate exponential micro-scaling
    if (tl.progress() > 0.4) { 
      // The timeline is 5 units long (0-1, 1-2, 2-5). 
      // Progress 0.4 corresponds to start of Phase 3->4 (time 2.0 / 5.0)
      
      const zScale = Math.pow(SCALE_FACTOR, camState.zoomLevel);
      // At zoomLevel=0, we are at layer0 perfectly. To make it smooth,
      // we offset the base Z from where Phase 2 left off.
      // E.g. Phase 2 ended at Z=0.5. At zoomLevel=0, we transition from 0.5 downwards.
      
      const transitionFactor = Math.max(0, (tl.time() - 2) / 3); // 0 to 1 through phase 4
      
      if (transitionFactor > 0) {
        camera.position.z = 0.5 * zScale;
        
        // Sequence X/Y Interpolation
        let startIndex = Math.floor(camState.zoomLevel);
        let endIndex = Math.min(startIndex + 1, sequenceLayers.length - 1);
        let progress = camState.zoomLevel - startIndex;
        
        const easeProgress = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        
        camera.position.x = sequenceLayers[startIndex].x + (sequenceLayers[endIndex].x - sequenceLayers[startIndex].x) * easeProgress;
        camera.position.y = sequenceLayers[startIndex].y + (sequenceLayers[endIndex].y - sequenceLayers[startIndex].y) * easeProgress;
        
        // Opacity Fades
        sequenceLayers.forEach((layer, i) => {
          if (i > 0) {
            const fadeStart = i - 0.8;
            const fadeEnd = i - 0.2;
            if (camState.zoomLevel <= fadeStart) {
              layer.mesh.material.opacity = 0.0;
            } else if (camState.zoomLevel >= fadeEnd) {
              layer.mesh.material.opacity = 1.0;
            } else {
              layer.mesh.material.opacity = (camState.zoomLevel - fadeStart) / (fadeEnd - fadeStart);
            }
          }
        });
      } else {
        camera.position.z = camState.z;
        camera.position.x = camState.x;
        camera.position.y = camState.y;
      }
    } else {
      // Phase 1 and 2
      camera.position.z = camState.z;
      camera.position.x = camState.x;
      camera.position.y = camState.y;
    }
  });
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

init().catch(console.error);
