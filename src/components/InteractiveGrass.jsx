import React, { useRef, useEffect } from 'react';
import * as THREE from 'three/webgpu';
import {
  Fn, uniform, float, vec3, instancedArray, instanceIndex, uv,
  positionGeometry, positionWorld, sin, cos, pow, smoothstep, mix,
  sqrt, select, hash, time, deltaTime, PI, mx_noise_float
} from 'three/tsl';

export default function InteractiveGrass({ bladeCount = 120000 }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const BLADE_COUNT = bladeCount;
    const FIELD_SIZE = 30;
    const BACKGROUND_HEX = '#000000';
    const GROUND_HEX = '#050403';
    const BLADE_BASE_HEX = '#0a0806';
    const BLADE_TIP_HEX = '#c19a6b';

    // ─── Scene Setup ───────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND_HEX);
    scene.fog = new THREE.FogExp2(BACKGROUND_HEX, 0.035);

    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 100);
    // Locked overhead / angled camera position as requested
    camera.position.set(0, 10, 15);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGPURenderer({ antialias: true });
    const maxDPR = window.innerWidth < 1200 ? 1.5 : Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(maxDPR);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    const domElement = renderer.domElement;
    containerRef.current.appendChild(domElement);

    // ─── GPU Buffers ────────────────────────────────────────────────────
    const bladeData = instancedArray(BLADE_COUNT, 'vec4');
    const bendState = instancedArray(BLADE_COUNT, 'vec4');
    const bladeBound = instancedArray(BLADE_COUNT, 'float');

    // ─── Uniforms ───────────────────────────────────────────────────────
    const mouseWorld = uniform(new THREE.Vector3(99999, 0, 99999));
    const mouseRadius = uniform(6.1);
    const mouseStrength = uniform(4.0);
    const outerRadius = uniform(9.4);
    const outerStrength = uniform(1.45);
    const camSphereWorld = uniform(new THREE.Vector3(99999, 0, 99999));
    const camSphereRadius = uniform(15.0);
    const camSphereStrength = uniform(5.9);

    const grassDensity = uniform(0.6);
    const windSpeed = uniform(1.3);
    const windAmplitude = uniform(0.21);
    const bladeWidth = uniform(4.0);
    const bladeTipWidth = uniform(0.19);
    const bladeHeight = uniform(1.6);
    const bladeHeightVariation = uniform(0.5);
    const bladeLean = uniform(1.1);
    const noiseAmplitude = uniform(1.85);
    const noiseFrequency = uniform(0.3);
    const noise2Amplitude = uniform(0.2);
    const noise2Frequency = uniform(15);
    const bladeColorVariation = uniform(0.93);
    const groundRadius = uniform(13.8);
    const groundFalloff = uniform(2.4);
    
    // Luxury color configurations
    const bladeBaseColor = uniform(new THREE.Color(0.02, 0.01, 0.01));
    const bladeTipColor = uniform(new THREE.Color(0.75, 0.60, 0.42));
    const backgroundColor = uniform(new THREE.Color(BACKGROUND_HEX));
    const groundColor = uniform(new THREE.Color(GROUND_HEX));
    const fogStart = uniform(6.5);
    const fogEnd = uniform(12.0);
    const fogIntensity = uniform(1.0);
    const fogColor = uniform(new THREE.Color(BACKGROUND_HEX));
    const goldenTipColor = uniform(new THREE.Color(0.75, 0.60, 0.42));
    const greenTipColor = uniform(new THREE.Color(0.20, 0.15, 0.10));
    const midColor = uniform(new THREE.Color(0.02, 0.01, 0.01));

    const noise2D = Fn(([x, z]) => mx_noise_float(vec3(x, float(0), z)).mul(0.5).add(0.5));

    // ─── Compute Init ──────────────────────────────────────────────────
    const computeInit = Fn(() => {
      const blade = bladeData.element(instanceIndex);
      const col = instanceIndex.mod(283);
      const row = instanceIndex.div(283);
      const jx = hash(instanceIndex).sub(0.5);
      const jz = hash(instanceIndex.add(7919)).sub(0.5);
      const wx = col.toFloat().add(jx).div(float(283)).sub(0.5).mul(FIELD_SIZE);
      const wz = row.toFloat().add(jz).div(float(283)).sub(0.5).mul(FIELD_SIZE);
      blade.x.assign(wx);
      blade.y.assign(wz);
      blade.z.assign(hash(instanceIndex.add(1337)).mul(PI.mul(2)));
      const n1 = noise2D(wx.mul(noiseFrequency), wz.mul(noiseFrequency));
      const n2 = noise2D(wx.mul(noiseFrequency.mul(noise2Frequency)).add(50), wz.mul(noiseFrequency.mul(noise2Frequency)).add(50));
      const clump = n1.mul(noiseAmplitude).sub(noise2Amplitude).add(n2.mul(noise2Amplitude).mul(2)).max(0);
      blade.w.assign(clump);
      const dist = sqrt(wx.mul(wx).add(wz.mul(wz)));
      const edgeNoise = noise2D(wx.mul(0.25).add(100), wz.mul(0.25).add(100));
      const maxR = float(12.0).add(edgeNoise.sub(0.5).mul(6.0));
      const boundary = float(1).sub(smoothstep(maxR.sub(1.5), maxR, dist));
      bladeBound.element(instanceIndex).assign(select(boundary.lessThan(0.05), float(0), boundary));
    })().compute(BLADE_COUNT);

    // ─── Compute Update ────────────────────────────────────────────────
    const computeUpdate = Fn(() => {
      const blade = bladeData.element(instanceIndex);
      const bend = bendState.element(instanceIndex);
      const bx = blade.x;
      const bz = blade.y;

      const w1 = sin(bx.mul(0.35).add(bz.mul(0.12)).add(time.mul(windSpeed)));
      const w2 = sin(bx.mul(0.18).add(bz.mul(0.28)).add(time.mul(windSpeed.mul(0.67))).add(1.7));
      const windX = w1.add(w2).mul(windAmplitude);
      const windZ = w1.sub(w2).mul(windAmplitude.mul(0.55));

      const lw = deltaTime.mul(4.0).saturate();
      bend.x.assign(mix(bend.x, windX, lw));
      bend.y.assign(mix(bend.y, windZ, lw));

      // Mouse push
      const dx = bx.sub(mouseWorld.x);
      const dz = bz.sub(mouseWorld.z);
      const dist = sqrt(dx.mul(dx).add(dz.mul(dz))).add(0.0001);
      const falloff = float(1).sub(dist.div(mouseRadius).saturate());
      const influence = falloff.mul(falloff).mul(mouseStrength);
      const pushX = dx.div(dist).mul(influence);
      const pushZ = dz.div(dist).mul(influence);

      // Outer mouse sphere
      const odx = bx.sub(mouseWorld.x);
      const odz = bz.sub(mouseWorld.z);
      const odist = sqrt(odx.mul(odx).add(odz.mul(odz))).add(0.0001);
      const ofalloff = float(1).sub(odist.div(outerRadius).saturate());
      const oinfluence = ofalloff.mul(ofalloff).mul(outerStrength);
      const opushX = odx.div(odist).mul(oinfluence);
      const opushZ = odz.div(odist).mul(oinfluence);

      // Camera sphere push
      const cdx = bx.sub(camSphereWorld.x);
      const cdz = bz.sub(camSphereWorld.z);
      const cdist = sqrt(cdx.mul(cdx).add(cdz.mul(cdz))).add(0.0001);
      const cfalloff = float(1).sub(cdist.div(camSphereRadius).saturate());
      const cinfluence = cfalloff.mul(cfalloff).mul(camSphereStrength);
      const cpushX = cdx.div(cdist).mul(cinfluence);
      const cpushZ = cdz.div(cdist).mul(cinfluence);

      const totalPushX = pushX.add(opushX).add(cpushX);
      const totalPushZ = pushZ.add(opushZ).add(cpushZ);

      const targetMag = sqrt(totalPushX.mul(totalPushX).add(totalPushZ.mul(totalPushZ)));
      const currentMag = sqrt(bend.z.mul(bend.z).add(bend.w.mul(bend.w)));
      const lm = select(targetMag.greaterThan(currentMag), deltaTime.mul(12.0), deltaTime.mul(1)).saturate();
      bend.z.assign(mix(bend.z, totalPushX, lm));
      bend.w.assign(mix(bend.w, totalPushZ, lm));
    })().compute(BLADE_COUNT);

    // ─── Blade Geometry ────────────────────────────────────────────────
    function createBladeGeometry() {
      const segs = 5, W = 0.055, H = 1.0;
      const verts = [], norms = [], uvArr = [], idx = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs, y = t * H, hw = W * 0.5 * (1.0 - t * 0.82);
        verts.push(-hw, y, 0, hw, y, 0);
        norms.push(0, 0, 1, 0, 0, 1);
        uvArr.push(0, t, 1, t);
      }
      for (let i = 0; i < segs; i++) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
      geo.setIndex(idx);
      return geo;
    }

    // ─── Grass Material ────────────────────────────────────────────────
    const grassMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: true });

    grassMat.positionNode = Fn(() => {
      const blade = bladeData.element(instanceIndex);
      const bend = bendState.element(instanceIndex);
      const worldX = blade.x, worldZ = blade.y, rotY = blade.z;
      const boundary = bladeBound.element(instanceIndex);
      const visible = select(hash(instanceIndex.add(9999)).lessThan(grassDensity.mul(0.5)), float(1), float(0));
      const hVar = hash(instanceIndex.add(5555)).mul(bladeHeightVariation);
      const heightScale = float(0.35).add(blade.w).add(hVar).mul(boundary).mul(visible);
      const taper = float(1).sub(uv().y.mul(float(1).sub(bladeTipWidth)));
      const lx = positionGeometry.x.mul(bladeWidth).mul(taper).mul(heightScale.sign());
      const ly = positionGeometry.y.mul(heightScale).mul(bladeHeight);
      const cY = cos(rotY), sY = sin(rotY);
      const rx = lx.mul(cY), rz = lx.mul(sY);
      const t = uv().y;
      const bendFactor = pow(t, 1.8);
      const staticBendX = hash(instanceIndex.add(7777)).sub(0.5).mul(bladeLean);
      const staticBendZ = hash(instanceIndex.add(8888)).sub(0.5).mul(bladeLean);
      const bendX = staticBendX.add(bend.x).add(bend.z);
      const bendZ = staticBendZ.add(bend.y).add(bend.w);
      const relX = rx.add(bendX.mul(bendFactor).mul(bladeHeight));
      const relY = ly;
      const relZ = rz.add(bendZ.mul(bendFactor).mul(bladeHeight));
      const origLen = sqrt(rx.mul(rx).add(ly.mul(ly)).add(rz.mul(rz)));
      const newLen = sqrt(relX.mul(relX).add(relY.mul(relY)).add(relZ.mul(relZ)));
      const scale = origLen.div(newLen.max(0.0001));
      return vec3(worldX.add(relX.mul(scale)), relY.mul(scale), worldZ.add(relZ.mul(scale)));
    })();

    grassMat.colorNode = Fn(() => {
      const t = uv().y;
      const clump = bladeData.element(instanceIndex).w.saturate();
      const bladeHash = hash(instanceIndex.add(4242));
      const isGolden = bladeHash.lessThan(0.4);
      const lowerGrad = smoothstep(float(0.0), float(0.45), t);
      const upperGrad = smoothstep(float(0.4), float(0.85), t);
      const tipMix = float(1).sub(bladeColorVariation).add(clump.mul(bladeColorVariation));
      const greenTip = mix(greenTipColor, bladeTipColor, tipMix);
      const warmTip = mix(greenTipColor, goldenTipColor, tipMix);
      const tipFinal = mix(greenTip, warmTip, select(isGolden, float(1), float(0)));
      const lowerColor = mix(bladeBaseColor, midColor, lowerGrad);
      const grassColor = mix(lowerColor, tipFinal, upperGrad);
      const blade = bladeData.element(instanceIndex);
      const dist = sqrt(blade.x.mul(blade.x).add(blade.y.mul(blade.y)));
      const fogFactor = smoothstep(fogStart, fogEnd, dist).mul(fogIntensity);
      return mix(grassColor, fogColor, fogFactor);
    })();

    grassMat.opacityNode = Fn(() => {
      const blade = bladeData.element(instanceIndex);
      const dist = sqrt(blade.x.mul(blade.x).add(blade.y.mul(blade.y)));
      const fadeEnd = float(15.0);
      const fadeFactor = float(1).sub(smoothstep(fadeEnd.sub(5.0), fadeEnd, dist));
      return smoothstep(float(0.0), float(0.1), uv().y).mul(fadeFactor);
    })();
    grassMat.transparent = true;

    // ─── Instances ─────────────────────────────────────────────────────
    const bladeGeo = createBladeGeometry();
    const grass = new THREE.InstancedMesh(bladeGeo, grassMat, BLADE_COUNT);
    grass.frustumCulled = false;
    scene.add(grass);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < BLADE_COUNT; i++) grass.setMatrixAt(i, dummy.matrix);
    grass.instanceMatrix.needsUpdate = true;

    // ─── Ground ────────────────────────────────────────────────────────
    const groundMat = new THREE.MeshBasicNodeMaterial();
    groundMat.colorNode = Fn(() => {
      const wx = positionWorld.x, wz = positionWorld.z;
      const dist = sqrt(wx.mul(wx).add(wz.mul(wz)));
      const edgeNoise = noise2D(wx.mul(0.25).add(100), wz.mul(0.25).add(100));
      const maxR = groundRadius.add(edgeNoise.sub(0.5).mul(4.0));
      const t = smoothstep(maxR.sub(groundFalloff), maxR, dist);
      return mix(groundColor, backgroundColor, t);
    })();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_SIZE * 5, FIELD_SIZE * 5), groundMat);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    // ─── Lighting ──────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0xaaccff, 0.3));
    const dirLight = new THREE.DirectionalLight(0xffeebb, 1.5);
    dirLight.position.set(-5, 10, 7);
    scene.add(dirLight);

    // ─── Mouse Raycasting ──────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const mouseNDC = new THREE.Vector2();
    const grassPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();

    const onMouseMove = (e) => {
      mouseNDC.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(mouseNDC, camera);
      if (raycaster.ray.intersectPlane(grassPlane, hitPoint)) {
        mouseWorld.value.copy(hitPoint);
      }
    };
    const onMouseLeave = () => {
      mouseWorld.value.set(99999, 0, 99999);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      const dpr = window.innerWidth < 1200 ? 1.5 : Math.min(window.devicePixelRatio, 2);
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    // ─── Setup compute pipelines ───────────────────────────────────────
    let setupRun = false;
    const initializeRenderer = async () => {
      await renderer.init();
      await renderer.computeAsync(computeInit);
      setupRun = true;
    };
    initializeRenderer();

    const clock = new THREE.Clock();

    const animate = () => {
      if (!setupRun) return;
      
      const dt = Math.min(clock.getDelta(), 0.05);

      // Camera sphere — always push grass away from camera base
      camSphereWorld.value.set(camera.position.x, 0, camera.position.z);

      renderer.compute(computeUpdate);
      renderer.render(scene, camera);
    };

    renderer.setAnimationLoop(animate);

    // ─── Cleanup ───────────────────────────────────────────────────────
    return () => {
      renderer.setAnimationLoop(null);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('resize', onResize);

      // Dispose resources
      bladeGeo.dispose();
      grassMat.dispose();
      ground.geometry.dispose();
      groundMat.dispose();
      renderer.dispose();

      if (containerRef.current && domElement.parentNode === containerRef.current) {
        containerRef.current.removeChild(domElement);
      }
    };
  }, [bladeCount]);

  return <div ref={containerRef} className="w-full h-full absolute inset-0 z-0 overflow-hidden pointer-events-none" />;
}
