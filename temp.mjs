
		import * as THREE from 'three/webgpu';
		import {
			Fn, uniform, float, vec3, instancedArray, instanceIndex, uv,
			positionGeometry, positionWorld, sin, cos, pow, smoothstep, mix,
			sqrt, select, hash, time, deltaTime, PI, mx_noise_float,
			pass, mrt, output, transformedNormalView,
		} from 'three/tsl';
		import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';

		const BLADE_COUNT = 120000;
		const FIELD_SIZE = 30;
		const BACKGROUND_HEX = '#000000';
		const GROUND_HEX = '#000208';
		const BLADE_BASE_HEX = '#021830';
		const BLADE_TIP_HEX = '#30c8d8';

		// ─── Sky Gradient ──────────────────────────────────────────────────
		const skyColors = {
			top:     new THREE.Color('#000000'),
			midHigh: new THREE.Color('#000508'),
			midLow:  new THREE.Color('#000a12'),
			horizon: new THREE.Color('#001020'),
		};

		function buildSkyTexture() {
			const w = 2, h = 512;
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			const grad = ctx.createLinearGradient(0, 0, 0, h);
			grad.addColorStop(0.0,  '#' + skyColors.top.getHexString());
			grad.addColorStop(0.35, '#' + skyColors.midHigh.getHexString());
			grad.addColorStop(0.65, '#' + skyColors.midLow.getHexString());
			grad.addColorStop(1.0,  '#' + skyColors.horizon.getHexString());
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, w, h);
			const tex = new THREE.CanvasTexture(canvas);
			tex.mapping = THREE.EquirectangularReflectionMapping;
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.needsUpdate = true;
			return tex;
		}

		// ─── Scene ─────────────────────────────────────────────────────────
		const scene = new THREE.Scene();
		scene.background = buildSkyTexture();
		scene.fog = new THREE.FogExp2('#000810', 0.035);

		const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100);
		camera.position.set(0, 8, 18);
		camera.lookAt(0, 0, 0);

		const renderer = new THREE.WebGPURenderer({ antialias: true });
		const isMobile = window.innerWidth < 768;
		const maxDPR = window.innerWidth < 1200 ? 1.5 : Math.min(devicePixelRatio, 2);
		renderer.setPixelRatio(maxDPR);
		renderer.setSize(innerWidth, innerHeight);
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.0;
		/* Using existing grass-canvas instead of appending new one */
		await renderer.init();

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

		const grassDensity = uniform(1.0);
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
		const bladeBaseColor = uniform(new THREE.Color(BLADE_BASE_HEX));
		const bladeTipColor = uniform(new THREE.Color(BLADE_TIP_HEX));
		const backgroundColor = uniform(new THREE.Color(BACKGROUND_HEX));
		const groundColor = uniform(new THREE.Color(GROUND_HEX));
		const fogStart = uniform(6.5);
		const fogEnd = uniform(12.0);
		const fogIntensity = uniform(1.0);
		const fogColor = uniform(new THREE.Color('#000810'));
		let fogEnabled = true;
		const goldenTipColor = uniform(new THREE.Color('#18a8c8'));
		const greenTipColor = uniform(new THREE.Color('#0a4a70'));
		const midColor = uniform(new THREE.Color('#062840'));

		// ─── DoF Uniforms ──────────────────────────────────────────────────
		const focusDistanceU = uniform(31.83);
		const focalLengthU = uniform(10.0);
		const bokehScaleU = uniform(12.5);
		let dofEnabled = true;

		// Mouse-world distance for auto-focus
		let mouseFocusDist = 10.0;
		let autoFocusSmoothed = 10.0;

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
			const fadeEnd = select(fogIntensity.greaterThan(0.01), fogEnd.add(2.0), float(15.0));
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
		scene.add(new THREE.AmbientLight(0xaaccff, 0.5));
		const dirLight = new THREE.DirectionalLight(0x80d8f0, 1.4);
		dirLight.position.set(-5, 10, 7);
		scene.add(dirLight);

		// ─── Post Processing (DoF) ─────────────────────────────────────────
		const postProcessing = new THREE.PostProcessing(renderer);
		const scenePass = pass(scene, camera);
		scenePass.setMRT(mrt({
			output: output,
			normal: transformedNormalView,
		}));
		const sceneColor = scenePass.getTextureNode('output');
		const sceneViewZ = scenePass.getViewZNode();
		const dofOutput = dof(sceneColor, sceneViewZ, focusDistanceU, focalLengthU, bokehScaleU);

		// Start with DoF ON (except mobile)
		postProcessing.outputNode = isMobile ? sceneColor : dofOutput;
		if (isMobile) dofEnabled = false;
		postProcessing.needsUpdate = true;

		function rebuildPipeline() {
			if (dofEnabled) {
				postProcessing.outputNode = dofOutput;
			} else {
				postProcessing.outputNode = sceneColor;
			}
			postProcessing.needsUpdate = true;
		}

		// ─── Mouse ─────────────────────────────────────────────────────────
		const raycaster = new THREE.Raycaster();
		const mouseNDC = new THREE.Vector2();
		const grassPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
		const hitPoint = new THREE.Vector3();

		window.addEventListener('mousemove', (e) => {
			mouseNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
			raycaster.setFromCamera(mouseNDC, camera);
			if (raycaster.ray.intersectPlane(grassPlane, hitPoint)) {
				mouseWorld.value.copy(hitPoint);
				// Compute distance from camera to mouse hit for auto-focus
				mouseFocusDist = camera.position.distanceTo(hitPoint);
			}
		});
		window.addEventListener('mouseleave', () => mouseWorld.value.set(99999, 0, 99999));

		let resizeTimeout;
		window.addEventListener('resize', () => {
			clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(() => {
				camera.aspect = innerWidth / innerHeight;
				camera.updateProjectionMatrix();
				const dpr = window.innerWidth < 1200 ? 1.5 : Math.min(devicePixelRatio, 2);
				renderer.setPixelRatio(dpr);
				renderer.setSize(innerWidth, innerHeight);
			}, 100);
		});

		// ─── Settings Panel (keyboard S) ───────────────────────────────────
		const settingsPanel = document.getElementById('settingsPanel');
		let settingsOpen = false;

		const settingsGear = document.getElementById('settingsGear');

		function toggleSettings() {
			settingsOpen = !settingsOpen;
			settingsPanel.classList.toggle('open', settingsOpen);
			settingsGear.classList.toggle('active', settingsOpen);
		}

		settingsGear.addEventListener('click', toggleSettings);

		window.addEventListener('keydown', (e) => {
			if (e.key === 's' || e.key === 'S') {
				// Don't toggle if user is typing in an input
				if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
				toggleSettings();
			}
		});

		function buildSettings() {
				// Color pickers (global scene colors not driven per-stage)
			const colorControls = [
				{ label: 'Background', u: backgroundColor, extra: (hex) => {
					scene.background.set(hex);
				}},
				{ label: 'Ground', u: groundColor },
			];

			let html = '';

			// Scene colors (global, not per-stage)
			html += `<div class="sp-section"><div class="sp-section-title">Global Colors</div>`;
			colorControls.forEach((c, idx) => {
				const id = `sp_color_${idx}`;
				const hex = '#' + c.u.value.getHexString();
				html += `<div class="sp-color-row"><span class="sp-label">${c.label}</span><input type="color" class="sp-color-input" id="${id}" value="${hex}"></div>`;
			});
			html += `</div>`;

			// Sky Gradient
			html += `<div class="sp-section"><div class="sp-section-title">Sky Gradient</div>`;
			const skyControls = [
				{ label: 'Top (Zenith)', key: 'top' },
				{ label: 'Mid High', key: 'midHigh' },
				{ label: 'Mid Low', key: 'midLow' },
				{ label: 'Horizon', key: 'horizon' },
			];
			skyControls.forEach((c, idx) => {
				const id = `sp_sky_${idx}`;
				const hex = '#' + skyColors[c.key].getHexString();
				html += `<div class="sp-color-row"><span class="sp-label">${c.label}</span><input type="color" class="sp-color-input" id="${id}" value="${hex}"></div>`;
			});
			html += `</div>`;

			// Camera Path Editor — one stage per section
			html += `<div class="sp-section"><div class="sp-section-title">Camera Path</div>`;
			// Mode toggle: Scroll / Edit
			html += `<div style="display:flex;gap:6px;margin-bottom:12px;">`;
			html += `<button id="modeScrollBtn" style="flex:1;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;padding:7px 0;border:1px solid rgba(60,160,210,0.3);border-radius:6px;background:rgba(40,140,200,0.25);color:rgba(140,220,240,0.9);cursor:pointer;transition:all 0.3s;font-weight:500;">⏵ Scroll</button>`;
			html += `<button id="modeEditBtn" style="flex:1;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;padding:7px 0;border:1px solid rgba(60,140,200,0.12);border-radius:6px;background:rgba(60,140,200,0.06);color:rgba(100,190,220,0.4);cursor:pointer;transition:all 0.3s;font-weight:500;">✎ Edit</button>`;
			html += `</div>`;
			html += `<div id="modeHint" style="font-size:10px;color:rgba(100,190,220,0.3);margin-bottom:10px;line-height:1.5;">Scroll mode — camera follows scroll position naturally.</div>`;
			html += `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button id="copyPathBtn" style="font-size:9px;letter-spacing:1px;text-transform:uppercase;padding:4px 10px;border:1px solid rgba(60,140,200,0.2);border-radius:4px;background:rgba(60,140,200,0.08);color:rgba(100,190,220,0.5);cursor:pointer;transition:all 0.3s;white-space:nowrap;">Copy JSON</button></div>`;
			cameraPath.forEach((kf, i) => {
				const name = stageNames[i] || `Stage ${i}`;
				html += `<div class="cp-stage" id="cp_stage_${i}" data-stage="${i}" style="margin-bottom:8px;border:1px solid rgba(60,140,200,0.08);border-radius:8px;overflow:hidden;cursor:pointer;transition:opacity 0.3s;">`;
				html += `<div class="cp-header" data-stage="${i}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:rgba(60,140,200,0.04);transition:background 0.2s;">`;
				html += `<span class="sp-label" style="color:rgba(100,190,220,0.5);font-weight:500;pointer-events:none;">${name}</span>`;
				html += `<span style="font-size:9px;color:rgba(100,190,220,0.25);pointer-events:none;" id="cp_${i}_arrow">▸</span>`;
				html += `</div>`;
				html += `<div class="cp-controls" id="cp_${i}_controls" style="display:none;padding:6px 10px 10px;">`;
				// Camera position/look
				html += `<div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(100,190,220,0.3);margin-bottom:8px;">Camera</div>`;
				html += `<div class="sp-row"><span class="sp-label">Pos X</span><span class="sp-val" id="cp_${i}_px_v">${kf[1].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_px" min="-10" max="10" step="0.1" value="${kf[1]}">`;
				html += `<div class="sp-row"><span class="sp-label">Pos Y</span><span class="sp-val" id="cp_${i}_py_v">${kf[2].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_py" min="0.1" max="15" step="0.1" value="${kf[2]}">`;
				html += `<div class="sp-row"><span class="sp-label">Pos Z</span><span class="sp-val" id="cp_${i}_pz_v">${kf[3].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_pz" min="0" max="25" step="0.1" value="${kf[3]}">`;
				html += `<div class="sp-row"><span class="sp-label">Look X</span><span class="sp-val" id="cp_${i}_lx_v">${kf[4].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_lx" min="-5" max="5" step="0.1" value="${kf[4]}">`;
				html += `<div class="sp-row"><span class="sp-label">Look Y</span><span class="sp-val" id="cp_${i}_ly_v">${kf[5].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_ly" min="-2" max="3" step="0.1" value="${kf[5]}">`;
				html += `<div class="sp-row"><span class="sp-label">Look Z</span><span class="sp-val" id="cp_${i}_lz_v">${kf[6].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_lz" min="-10" max="10" step="0.1" value="${kf[6]}">`;
				html += `<div style="height:1px;background:rgba(60,140,200,0.08);margin:8px 0;"></div>`;
				// DoF
				html += `<div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(100,190,220,0.3);margin-bottom:8px;">Depth of Field</div>`;
				html += `<div class="sp-toggle-row"><span class="sp-label">DoF Enabled</span><div class="sp-toggle ${kf[9] ? 'active' : ''}" id="cp_${i}_dof"></div></div>`;
				html += `<div id="cp_${i}_dof_controls" style="${kf[9] ? '' : 'opacity:0.3;pointer-events:none;'}">`;
				html += `<div class="sp-toggle-row"><span class="sp-label">Auto Focus</span><div class="sp-toggle ${kf[8] ? 'active' : ''}" id="cp_${i}_af"></div></div>`;
				html += `<div id="cp_${i}_manual_focus" style="${kf[8] ? 'opacity:0.3;pointer-events:none;' : ''}">`;
				html += `<div class="sp-row"><span class="sp-label">Focus Dist</span><span class="sp-val" id="cp_${i}_fd_v">${kf[7].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_fd" min="0.3" max="40" step="0.1" value="${kf[7]}">`;
				html += `</div>`;
				html += `<div id="cp_${i}_af_settings" style="${kf[8] ? '' : 'opacity:0.3;pointer-events:none;'}">`;
				html += `<div class="sp-row"><span class="sp-label">AF Speed</span><span class="sp-val" id="cp_${i}_afspd_v">${kf[12].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_afspd" min="0.5" max="20" step="0.5" value="${kf[12]}">`;
				html += `<div class="sp-row"><span class="sp-label">AF Min</span><span class="sp-val" id="cp_${i}_afmin_v">${kf[13].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_afmin" min="0.1" max="10" step="0.1" value="${kf[13]}">`;
				html += `<div class="sp-row"><span class="sp-label">AF Max</span><span class="sp-val" id="cp_${i}_afmax_v">${kf[14].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_afmax" min="1" max="50" step="0.5" value="${kf[14]}">`;
				html += `</div>`;
				html += `<div class="sp-row"><span class="sp-label">Focal Length</span><span class="sp-val" id="cp_${i}_fl_v">${kf[10].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_fl" min="0.1" max="20" step="0.1" value="${kf[10]}">`;
				html += `<div class="sp-row"><span class="sp-label">Bokeh Scale</span><span class="sp-val" id="cp_${i}_bk_v">${kf[11].toFixed(1)}</span></div>`;
				html += `<input type="range" class="sp-slider" id="cp_${i}_bk" min="0" max="40" step="0.5" value="${kf[11]}">`;
				html += `</div>`;
				html += `<div style="height:1px;background:rgba(60,140,200,0.08);margin:8px 0;"></div>`;
				// Per-stage params grouped
				const sp = stageParams[i];
				const groups = {};
				stageParamKeys.forEach(k => {
					const d = stageParamDefs[k];
					if (!groups[d.group]) groups[d.group] = [];
					groups[d.group].push({ key: k, ...d, val: sp[k] });
				});
				// Group color channels into combined color pickers + individual sliders
				Object.keys(groups).forEach(grp => {
					html += `<div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(100,190,220,0.3);margin:8px 0 6px;">Stage ${grp}</div>`;
					// Find color groups for combined pickers
					const colorGroupsMap = {};
					groups[grp].forEach(c => {
						if (c.isColor) {
							if (!colorGroupsMap[c.isColor]) colorGroupsMap[c.isColor] = [];
							colorGroupsMap[c.isColor].push(c);
						}
					});
					// Render combined color pickers first
					const renderedColorKeys = new Set();
					Object.keys(colorGroupsMap).forEach(colorName => {
						const channels = colorGroupsMap[colorName];
						const rCh = channels.find(c => c.ch === 'r');
						const gCh = channels.find(c => c.ch === 'g');
						const bCh = channels.find(c => c.ch === 'b');
						if (rCh && gCh && bCh) {
							const r = Math.round(rCh.val * 255), g = Math.round(gCh.val * 255), b = Math.round(bCh.val * 255);
							const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
							const cpId = `sp_stage_${i}_cpick_${colorName}`;
							const shortLabel = colorName.replace('Color','').replace(/([A-Z])/g,' $1').trim();
							html += `<div class="sp-color-row"><span class="sp-label">${shortLabel}</span><input type="color" class="sp-color-input" id="${cpId}" value="${hex}"></div>`;
							channels.forEach(c => renderedColorKeys.add(c.key));
						}
					});
					// Now render all sliders (including color channel sliders for fine-tuning)
					groups[grp].forEach(c => {
						const sid = `sp_stage_${i}_${c.key}`;
						html += `<div class="sp-row"><span class="sp-label">${c.label}</span><span class="sp-val" id="${sid}_v">${c.val.toFixed(2)}</span></div>`;
						html += `<input type="range" class="sp-slider" id="${sid}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.val}">`;
					});
				});
				html += `</div>`;
				html += `</div>`;
			});
			html += `</div>`;

			// Typography Colors
			html += `<div class="sp-section"><div class="sp-section-title">Typography Colors</div>`;
			const typoColors = [
				{ label: 'Heading', cssVar: '--color-heading', defaultVal: '#f0f8fc' },
				{ label: 'Accent / Emphasis', cssVar: '--color-accent', defaultVal: '#50dcf0' },
				{ label: 'Body Text', cssVar: '--color-body', defaultVal: '#b4dcf0' },
				{ label: 'Labels / Caps', cssVar: '--color-label', defaultVal: '#78d2f0' },
			];
			typoColors.forEach((tc, idx) => {
				const id = `sp_typo_${idx}`;
				// Read current computed value or use default
				const current = getComputedStyle(document.documentElement).getPropertyValue(tc.cssVar).trim() || tc.defaultVal;
				html += `<div class="sp-color-row"><span class="sp-label">${tc.label}</span><input type="color" class="sp-color-input" id="${id}" value="${tc.defaultVal}"></div>`;
			});
			html += `</div>`;

			// Global Rendering
			html += `<div class="sp-section"><div class="sp-section-title">Rendering</div>`;
			html += `<div class="sp-toggle-row"><span class="sp-label">Depth of Field</span><div class="sp-toggle ${globalDofEnabled ? 'active' : ''}" id="globalDofToggle"></div></div>`; // ocean variant
			html += `</div>`;

			// Debug
			html += `<div class="sp-section"><div class="sp-section-title">Debug</div>`;
			html += `<div class="sp-toggle-row"><span class="sp-label">FPS Counter</span><div class="sp-toggle" id="fpsToggle"></div></div>`;
			html += `</div>`;

			settingsPanel.innerHTML = html;

			// Wire sky gradient pickers
			skyControls.forEach((c, idx) => {
				const id = `sp_sky_${idx}`;
				const input = document.getElementById(id);
				input.addEventListener('input', () => {
					skyColors[c.key].set(input.value);
					scene.background = buildSkyTexture();
				});
			});

			// Wire color pickers
			colorControls.forEach((c, idx) => {
				const id = `sp_color_${idx}`;
				const input = document.getElementById(id);
				input.addEventListener('input', () => {
					c.u.value.set(input.value);
					if (c.extra) c.extra(input.value);
				});
			});

			// Camera path editor wiring
			let activeStage = -1;
			let cameraOverride = -1;
			let editorMode = 'scroll'; // 'scroll' or 'edit'

			const modeScrollBtn = document.getElementById('modeScrollBtn');
			const modeEditBtn = document.getElementById('modeEditBtn');
			const modeHint = document.getElementById('modeHint');

			function setMode(mode) {
				editorMode = mode;
				if (mode === 'scroll') {
					modeScrollBtn.style.background = 'rgba(40,140,200,0.25)';
					modeScrollBtn.style.borderColor = 'rgba(60,160,210,0.3)';
					modeScrollBtn.style.color = 'rgba(140,220,240,0.9)';
					modeEditBtn.style.background = 'rgba(60,140,200,0.06)';
					modeEditBtn.style.borderColor = 'rgba(60,140,200,0.12)';
					modeEditBtn.style.color = 'rgba(100,190,220,0.4)';
					modeHint.textContent = 'Scroll mode — camera follows scroll position naturally.';
					// Collapse any open stage and release override
					if (activeStage >= 0) {
						const prevControls = document.getElementById(`cp_${activeStage}_controls`);
						const prevArrow = document.getElementById(`cp_${activeStage}_arrow`);
						const prevStage = document.getElementById(`cp_stage_${activeStage}`);
						if (prevControls) prevControls.style.display = 'none';
						if (prevArrow) prevArrow.textContent = '▸';
						if (prevStage) prevStage.style.borderColor = 'rgba(140,180,120,0.08)';
					}
					activeStage = -1;
					cameraOverride = -1;
					// Dim all stage headers
					cameraPath.forEach((_, j) => {
						const el = document.getElementById(`cp_stage_${j}`);
						if (el) { el.style.opacity = '0.5'; el.style.pointerEvents = 'none'; }
					});
				} else {
					modeEditBtn.style.background = 'rgba(40,140,200,0.25)';
					modeEditBtn.style.borderColor = 'rgba(60,160,210,0.3)';
					modeEditBtn.style.color = 'rgba(140,220,240,0.9)';
					modeScrollBtn.style.background = 'rgba(60,140,200,0.06)';
					modeScrollBtn.style.borderColor = 'rgba(60,140,200,0.12)';
					modeScrollBtn.style.color = 'rgba(100,190,220,0.4)';
					modeHint.textContent = 'Edit mode — click a stage to lock camera & tweak values. Switch to Scroll to preview transitions.';
					// Enable all stage headers
					cameraPath.forEach((_, j) => {
						const el = document.getElementById(`cp_stage_${j}`);
						if (el) { el.style.opacity = '1'; el.style.pointerEvents = 'auto'; }
					});
					// Auto-select first stage (or re-select previously active)
					const startStage = activeStage >= 0 ? activeStage : 0;
					selectStage(startStage);
				}
			}

			modeScrollBtn.addEventListener('click', () => setMode('scroll'));
			modeEditBtn.addEventListener('click', () => setMode('edit'));

			let expandedStage = -1;

			function selectStage(i) {
				// Deselect previous highlight
				if (activeStage >= 0 && activeStage !== i) {
					const prevStage = document.getElementById(`cp_stage_${activeStage}`);
					if (prevStage) prevStage.style.borderColor = 'rgba(140,180,120,0.08)';
					// Collapse previous if it was expanded
					if (expandedStage === activeStage) {
						const prevControls = document.getElementById(`cp_${activeStage}_controls`);
						const prevArrow = document.getElementById(`cp_${activeStage}_arrow`);
						if (prevControls) prevControls.style.display = 'none';
						if (prevArrow) prevArrow.textContent = '▸';
						expandedStage = -1;
					}
				}
				// Highlight selected (but don't expand)
				const stageEl = document.getElementById(`cp_stage_${i}`);
				if (stageEl) stageEl.style.borderColor = 'rgba(80,180,220,0.35)';
				activeStage = i;
				cameraOverride = i;
				modeHint.textContent = `Editing: ${stageNames[i]} — click again to expand controls.`;
				scrollToStage(i);
				// Force scroll position to match keyframe so scroll and edit mode are consistent
				currentScrollT = cameraPath[i][0];
				targetScrollT = cameraPath[i][0];

				// Force-apply this stage's params to uniforms immediately so preview is correct
				const kf = cameraPath[i];
				const sp = stageParams[i];
				camera.position.set(kf[1], kf[2], kf[3]);
				lookTarget.set(kf[4], kf[5], kf[6]);
				camera.lookAt(lookTarget);
				// Apply all per-stage params to uniforms right now
				fogStart.value = sp.fogStart;
				fogEnd.value = sp.fogEnd;
				fogIntensity.value = sp.fogIntensity;
				fogColor.value.setRGB(sp.fogR, sp.fogG, sp.fogB);
				if (scene.fog) scene.fog.color.setRGB(sp.fogR, sp.fogG, sp.fogB);
				grassDensity.value = sp.grassDensity;
				bladeWidth.value = sp.bladeWidth;
				bladeTipWidth.value = sp.bladeTipWidth;
				bladeHeight.value = sp.bladeHeight;
				bladeHeightVariation.value = sp.bladeHeightVar;
				bladeLean.value = sp.bladeLean;
				_baseWindSpeed = sp.windSpeed;
				_baseWindAmp = sp.windAmplitude;
				windSpeed.value = sp.windSpeed;
				windAmplitude.value = sp.windAmplitude;
				noiseAmplitude.value = sp.noiseAmp;
				noiseFrequency.value = sp.noiseFreq;
				noise2Amplitude.value = sp.noise2Amp;
				noise2Frequency.value = sp.noise2Freq;
				mouseRadius.value = sp.mouseRadius;
				mouseStrength.value = sp.mouseStrength;
				outerRadius.value = sp.outerRadius;
				outerStrength.value = sp.outerStrength;
				bladeBaseColor.value.setRGB(sp.bladeBaseR, sp.bladeBaseG, sp.bladeBaseB);
				bladeTipColor.value.setRGB(sp.bladeTipR, sp.bladeTipG, sp.bladeTipB);
				goldenTipColor.value.setRGB(sp.goldenTipR, sp.goldenTipG, sp.goldenTipB);
				greenTipColor.value.setRGB(sp.greenTipR, sp.greenTipG, sp.greenTipB);
				midColor.value.setRGB(sp.midR, sp.midG, sp.midB);
				bladeColorVariation.value = sp.colorVar;
				camSphereRadius.value = sp.camSphereRadius;
				camSphereStrength.value = sp.camSphereStrength;
				// DoF
				const shouldDof = !!kf[9];
				if (shouldDof !== dofEnabled) {
					dofEnabled = shouldDof;
					rebuildPipeline();
				}
				if (dofEnabled) {
					focusDistanceU.value = kf[7];
					focalLengthU.value = kf[10];
					bokehScaleU.value = kf[11];
				}
			}

			// Initialize — start in scroll mode, stages dimmed
			setMode('scroll');

			function scrollToStage(stageIndex) {
				const section = document.querySelector(`.section[data-stage="${stageIndex}"]`);
				if (section) {
					section.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
			}

			cameraPath.forEach((kf, i) => {
				const header = document.querySelector(`#cp_stage_${i} .cp-header`);
				const controls = document.getElementById(`cp_${i}_controls`);
				const arrow = document.getElementById(`cp_${i}_arrow`);
				const stageEl = document.getElementById(`cp_stage_${i}`);


				header.addEventListener('click', () => {
					// Only respond in edit mode
					if (editorMode !== 'edit') return;

					if (activeStage === i) {
						// Already selected — toggle expand/collapse
						const controls = document.getElementById(`cp_${i}_controls`);
						const arrow = document.getElementById(`cp_${i}_arrow`);
						if (expandedStage === i) {
							// Collapse
							if (controls) controls.style.display = 'none';
							if (arrow) arrow.textContent = '▸';
							expandedStage = -1;
							modeHint.textContent = `Editing: ${stageNames[i]} — click again to expand controls.`;
						} else {
							// Expand
							if (controls) controls.style.display = 'block';
							if (arrow) arrow.textContent = '▾';
							expandedStage = i;
							modeHint.textContent = `Editing: ${stageNames[i]} — changes apply in real-time.`;
						}
						return;
					}

					selectStage(i);
				});

				// Wire all 6 sliders (posX, posY, posZ, lookX, lookY, lookZ)
				const fields = [
					{ key: 'px', idx: 1 },
					{ key: 'py', idx: 2 },
					{ key: 'pz', idx: 3 },
					{ key: 'lx', idx: 4 },
					{ key: 'ly', idx: 5 },
					{ key: 'lz', idx: 6 },
				];

				fields.forEach(f => {
					const slider = document.getElementById(`cp_${i}_${f.key}`);
					const valEl = document.getElementById(`cp_${i}_${f.key}_v`);
					slider.addEventListener('input', () => {
						kf[f.idx] = parseFloat(slider.value);
						valEl.textContent = kf[f.idx].toFixed(1);
					});
				});

				// DoF enabled toggle per stage
				const dofToggleEl = document.getElementById(`cp_${i}_dof`);
				const dofControlsEl = document.getElementById(`cp_${i}_dof_controls`);
				dofToggleEl.addEventListener('click', () => {
					kf[9] = kf[9] ? 0 : 1;
					dofToggleEl.classList.toggle('active', !!kf[9]);
					dofControlsEl.style.opacity = kf[9] ? '1' : '0.3';
					dofControlsEl.style.pointerEvents = kf[9] ? 'auto' : 'none';
				});

				// Focus distance slider
				const fdSlider = document.getElementById(`cp_${i}_fd`);
				const fdVal = document.getElementById(`cp_${i}_fd_v`);
				fdSlider.addEventListener('input', () => {
					kf[7] = parseFloat(fdSlider.value);
					fdVal.textContent = kf[7].toFixed(1);
				});

				// Auto focus toggle per stage
				const afToggle = document.getElementById(`cp_${i}_af`);
				const manualFocusEl = document.getElementById(`cp_${i}_manual_focus`);
				const afSettingsEl = document.getElementById(`cp_${i}_af_settings`);
				afToggle.addEventListener('click', () => {
					kf[8] = kf[8] ? 0 : 1;
					afToggle.classList.toggle('active', !!kf[8]);
					manualFocusEl.style.opacity = kf[8] ? '0.3' : '1';
					manualFocusEl.style.pointerEvents = kf[8] ? 'none' : 'auto';
					afSettingsEl.style.opacity = kf[8] ? '1' : '0.3';
					afSettingsEl.style.pointerEvents = kf[8] ? 'auto' : 'none';
				});

				// AF Speed slider
				const afspdSlider = document.getElementById(`cp_${i}_afspd`);
				const afspdVal = document.getElementById(`cp_${i}_afspd_v`);
				afspdSlider.addEventListener('input', () => {
					kf[12] = parseFloat(afspdSlider.value);
					afspdVal.textContent = kf[12].toFixed(1);
				});

				// AF Min slider
				const afminSlider = document.getElementById(`cp_${i}_afmin`);
				const afminVal = document.getElementById(`cp_${i}_afmin_v`);
				afminSlider.addEventListener('input', () => {
					kf[13] = parseFloat(afminSlider.value);
					afminVal.textContent = kf[13].toFixed(1);
				});

				// AF Max slider
				const afmaxSlider = document.getElementById(`cp_${i}_afmax`);
				const afmaxVal = document.getElementById(`cp_${i}_afmax_v`);
				afmaxSlider.addEventListener('input', () => {
					kf[14] = parseFloat(afmaxSlider.value);
					afmaxVal.textContent = kf[14].toFixed(1);
				});

				// Focal Length slider
				const flSlider = document.getElementById(`cp_${i}_fl`);
				const flVal = document.getElementById(`cp_${i}_fl_v`);
				flSlider.addEventListener('input', () => {
					kf[10] = parseFloat(flSlider.value);
					flVal.textContent = kf[10].toFixed(1);
				});

				// Bokeh Scale slider
				const bkSlider = document.getElementById(`cp_${i}_bk`);
				const bkVal = document.getElementById(`cp_${i}_bk_v`);
				bkSlider.addEventListener('input', () => {
					kf[11] = parseFloat(bkSlider.value);
					bkVal.textContent = kf[11].toFixed(1);
				});

				// Wire per-stage param sliders
				stageParamKeys.forEach(k => {
					const sid = `sp_stage_${i}_${k}`;
					const slider = document.getElementById(sid);
					const valEl = document.getElementById(`${sid}_v`);
					if (slider && valEl) {
						slider.addEventListener('input', () => {
							const v = parseFloat(slider.value);
							stageParams[i][k] = v;
							valEl.textContent = v.toFixed(2);
							// Update the combined color picker if this is a color channel
							const d = stageParamDefs[k];
							if (d.isColor && d.ch) {
								updateStageColorPicker(i, d.isColor);
							}
						});
					}
				});

				// Wire combined color pickers for this stage
				const stageColorGroups = {};
				stageParamKeys.forEach(k => {
					const d = stageParamDefs[k];
					if (d.isColor) {
						if (!stageColorGroups[d.isColor]) stageColorGroups[d.isColor] = [];
						stageColorGroups[d.isColor].push(k);
					}
				});
				Object.keys(stageColorGroups).forEach(colorName => {
					const cpId = `sp_stage_${i}_cpick_${colorName}`;
					const cpEl = document.getElementById(cpId);
					if (cpEl) {
						cpEl.addEventListener('input', () => {
							const hex = cpEl.value;
							const r = parseInt(hex.substr(1,2),16)/255;
							const g = parseInt(hex.substr(3,2),16)/255;
							const b = parseInt(hex.substr(5,2),16)/255;
							// Find the R/G/B keys for this color
							stageColorGroups[colorName].forEach(k => {
								const d = stageParamDefs[k];
								if (d.ch === 'r') stageParams[i][k] = r;
								if (d.ch === 'g') stageParams[i][k] = g;
								if (d.ch === 'b') stageParams[i][k] = b;
								// Update associated slider + value display
								const sid = `sp_stage_${i}_${k}`;
								const sl = document.getElementById(sid);
								const vl = document.getElementById(`${sid}_v`);
								if (sl) sl.value = stageParams[i][k];
								if (vl) vl.textContent = stageParams[i][k].toFixed(2);
							});
						});
					}
				});
			});

			// Helper: update a combined color picker from individual channel sliders
			function updateStageColorPicker(stageIdx, colorName) {
				const cpId = `sp_stage_${stageIdx}_cpick_${colorName}`;
				const cpEl = document.getElementById(cpId);
				if (!cpEl) return;
				// Find the R/G/B keys
				let r = 0, g = 0, b = 0;
				stageParamKeys.forEach(k => {
					const d = stageParamDefs[k];
					if (d.isColor === colorName) {
						if (d.ch === 'r') r = stageParams[stageIdx][k];
						if (d.ch === 'g') g = stageParams[stageIdx][k];
						if (d.ch === 'b') b = stageParams[stageIdx][k];
					}
				});
				const hex = '#' + [r,g,b].map(v => Math.round(Math.min(1,Math.max(0,v))*255).toString(16).padStart(2,'0')).join('');
				cpEl.value = hex;
			}

			// Expose camera override for animate loop — only active in edit mode
			window._getCameraOverride = () => (editorMode === 'edit' ? cameraOverride : -1);
			window._getEditorMode = () => editorMode;

			// Copy Path JSON button
			const copyPathBtn = document.getElementById('copyPathBtn');
			copyPathBtn.addEventListener('mouseenter', () => {
				copyPathBtn.style.background = 'rgba(60,140,200,0.2)';
				copyPathBtn.style.borderColor = 'rgba(80,180,220,0.4)';
				copyPathBtn.style.color = 'rgba(140,220,240,0.8)';
			});
			copyPathBtn.addEventListener('mouseleave', () => {
				copyPathBtn.style.background = 'rgba(60,140,200,0.08)';
				copyPathBtn.style.borderColor = 'rgba(60,140,200,0.2)';
				copyPathBtn.style.color = 'rgba(100,190,220,0.5)';
			});
			copyPathBtn.addEventListener('click', () => {
				const json = JSON.stringify(cameraPath.map((kf, i) => ({
					stage: stageNames[i],
					scroll: kf[0],
					pos: { x: kf[1], y: kf[2], z: kf[3] },
					look: { x: kf[4], y: kf[5], z: kf[6] },
					focusDist: kf[7],
					autoFocus: !!kf[8],
					dofEnabled: !!kf[9],
					focalLength: kf[10],
					bokehScale: kf[11],
					afSpeed: kf[12],
					afMin: kf[13],
					afMax: kf[14],
					params: stageParams[i],
				})), null, 2);
				navigator.clipboard.writeText(json).then(() => {
					const orig = copyPathBtn.textContent;
					copyPathBtn.textContent = 'Copied!';
					copyPathBtn.style.color = 'rgba(80,230,240,0.9)';
					setTimeout(() => {
						copyPathBtn.textContent = orig;
						copyPathBtn.style.color = 'rgba(180,210,140,0.5)';
					}, 1500);
				}).catch(() => {
					// Fallback: select text in a textarea
					const ta = document.createElement('textarea');
					ta.value = json;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand('copy');
					document.body.removeChild(ta);
					const orig = copyPathBtn.textContent;
					copyPathBtn.textContent = 'Copied!';
					setTimeout(() => { copyPathBtn.textContent = orig; }, 1500);
				});
			});

			// Wire typography color pickers
			typoColors.forEach((tc, idx) => {
				const id = `sp_typo_${idx}`;
				const input = document.getElementById(id);
				input.addEventListener('input', () => {
					document.documentElement.style.setProperty(tc.cssVar, input.value);
				});
			});

			// Global DoF toggle
			const globalDofToggle = document.getElementById('globalDofToggle');
			globalDofToggle.addEventListener('click', () => {
				globalDofEnabled = !globalDofEnabled;
				globalDofToggle.classList.toggle('active', globalDofEnabled);
				if (!globalDofEnabled) {
					dofEnabled = false;
					rebuildPipeline();
				}
			});

			// FPS toggle
			const fpsToggle = document.getElementById('fpsToggle');
			fpsToggle.addEventListener('click', () => {
				fpsEnabled = !fpsEnabled;
				fpsToggle.classList.toggle('active', fpsEnabled);
				if (fpsOverlay) fpsOverlay.style.display = fpsEnabled ? 'block' : 'none';
			});
		}

		// ─── FPS Overlay ───────────────────────────────────────────────────
		let fpsEnabled = false;
		let fpsOverlay = document.createElement('div');
		fpsOverlay.style.cssText = 'position:fixed;top:10px;left:10px;z-index:400;font:12px/1 "Inter",monospace;color:rgba(80,210,240,0.6);background:rgba(0,0,0,0.4);padding:5px 10px;border-radius:6px;pointer-events:none;display:none;';
		document.body.appendChild(fpsOverlay);
		let fpsFrames = 0, fpsLast = performance.now();

		// ─── Wind Button ───────────────────────────────────────────────────
		let windBurst = 0;
		let _baseWindSpeed = 1.3;
		let _baseWindAmp = 0.21;
		let globalDofEnabled = !isMobile;

		// ─── Scroll-Driven Camera (one keyframe per section) ───────────────
		// [scrollProgress, posX, posY, posZ, lookX, lookY, lookZ]
		const stageNames = ['Hero', 'Manifesto', 'Pillars', 'Stats', 'Quote', 'CTA', 'Footer'];

		// Per-stage parameter definitions with defaults
		// Each key maps to: { uniform, default, min, max, step, label, group }
		const stageParamDefs = {
			// Fog
			fogStart:    { u: fogStart,    def: 6.5,  min: 0,   max: 20, step: 0.5, label: 'Fog Start',     group: 'Fog' },
			fogEnd:      { u: fogEnd,      def: 12.0, min: 1,   max: 30, step: 0.5, label: 'Fog End',       group: 'Fog' },
			fogIntensity:{ u: fogIntensity, def: 1.0, min: 0,   max: 1,  step: 0.01, label: 'Fog Intensity', group: 'Fog' },
			fogR:        { def: 0, min: 0, max: 1, step: 0.01, label: 'Fog Red',   group: 'Fog', isColor: 'fogColor', ch: 'r' },
			fogG:        { def: 0, min: 0, max: 1, step: 0.01, label: 'Fog Green', group: 'Fog', isColor: 'fogColor', ch: 'g' },
			fogB:        { def: 0, min: 0, max: 1, step: 0.01, label: 'Fog Blue',  group: 'Fog', isColor: 'fogColor', ch: 'b' },
			// Grass
			grassDensity:      { u: grassDensity,        def: 1.0,  min: 0,   max: 1,  step: 0.01, label: 'Density',        group: 'Grass' },
			bladeWidth:        { u: bladeWidth,           def: 4.0,  min: 0.2, max: 4,  step: 0.05, label: 'Blade Width',    group: 'Grass' },
			bladeTipWidth:     { u: bladeTipWidth,        def: 0.19, min: 0,   max: 1,  step: 0.01, label: 'Tip Width',      group: 'Grass' },
			bladeHeight:       { u: bladeHeight,          def: 1.6,  min: 0.1, max: 2,  step: 0.05, label: 'Blade Height',   group: 'Grass' },
			bladeHeightVar:    { u: bladeHeightVariation, def: 0.5,  min: 0,   max: 1,  step: 0.01, label: 'Height Var',     group: 'Grass' },
			bladeLean:         { u: bladeLean,            def: 1.1,  min: 0,   max: 3,  step: 0.05, label: 'Lean',           group: 'Grass' },
			// Wind
			windSpeed:    { u: windSpeed,     def: 1.3,  min: 0, max: 5, step: 0.1,  label: 'Wind Speed',  group: 'Wind' },
			windAmplitude:{ u: windAmplitude,  def: 0.21, min: 0, max: 1, step: 0.01, label: 'Wind Amp',    group: 'Wind' },
			// Noise
			noiseAmp:     { u: noiseAmplitude,  def: 1.85, min: 0,    max: 4,  step: 0.05, label: 'Noise Amp',    group: 'Noise' },
			noiseFreq:    { u: noiseFrequency,  def: 0.3,  min: 0.01, max: 1,  step: 0.01, label: 'Noise Freq',   group: 'Noise' },
			noise2Amp:    { u: noise2Amplitude, def: 0.2,  min: 0,    max: 1,  step: 0.01, label: 'Detail Amp',   group: 'Noise' },
			noise2Freq:   { u: noise2Frequency, def: 15,   min: 1,    max: 30, step: 0.5,  label: 'Detail Freq',  group: 'Noise' },
			// Mouse Sphere
			mouseRadius:   { u: mouseRadius,   def: 6.1,  min: 0.5, max: 8,  step: 0.1,  label: 'Mouse Radius',   group: 'Mouse Sphere' },
			mouseStrength: { u: mouseStrength,  def: 4.0,  min: 0,   max: 5,  step: 0.1,  label: 'Mouse Strength', group: 'Mouse Sphere' },
			outerRadius:   { u: outerRadius,    def: 9.4,  min: 1,   max: 12, step: 0.1,  label: 'Outer Radius',   group: 'Mouse Sphere' },
			outerStrength: { u: outerStrength,   def: 1.45, min: 0,   max: 3,  step: 0.05, label: 'Outer Strength', group: 'Mouse Sphere' },
			// Camera Sphere
			camSphereRadius:   { def: 15.0, min: 1,  max: 15, step: 0.1, label: 'Cam Radius',   group: 'Camera Sphere', noDirect: true },
			camSphereStrength: { def: 5.9,  min: 0,  max: 6,  step: 0.1, label: 'Cam Strength',  group: 'Camera Sphere', noDirect: true },
			// Scene Colors — blade base
			bladeBaseR: { def: 0.008, min: 0, max: 1, step: 0.01, label: 'Base Red',     group: 'Scene Colors', isColor: 'bladeBaseColor', ch: 'r' },
			bladeBaseG: { def: 0.047, min: 0, max: 1, step: 0.01, label: 'Base Green',   group: 'Scene Colors', isColor: 'bladeBaseColor', ch: 'g' },
			bladeBaseB: { def: 0.094, min: 0, max: 1, step: 0.01, label: 'Base Blue',    group: 'Scene Colors', isColor: 'bladeBaseColor', ch: 'b' },
			// Scene Colors — blade tip
			bladeTipR:  { def: 0.090, min: 0, max: 1, step: 0.01, label: 'Tip Red',      group: 'Scene Colors', isColor: 'bladeTipColor', ch: 'r' },
			bladeTipG:  { def: 0.620, min: 0, max: 1, step: 0.01, label: 'Tip Green',    group: 'Scene Colors', isColor: 'bladeTipColor', ch: 'g' },
			bladeTipB:  { def: 0.780, min: 0, max: 1, step: 0.01, label: 'Tip Blue',     group: 'Scene Colors', isColor: 'bladeTipColor', ch: 'b' },
			// Scene Colors — golden tip (renamed: luminous tip)
			goldenTipR: { def: 0.060, min: 0, max: 1, step: 0.01, label: 'Glow Tip R',   group: 'Scene Colors', isColor: 'goldenTipColor', ch: 'r' },
			goldenTipG: { def: 0.500, min: 0, max: 1, step: 0.01, label: 'Glow Tip G',   group: 'Scene Colors', isColor: 'goldenTipColor', ch: 'g' },
			goldenTipB: { def: 0.720, min: 0, max: 1, step: 0.01, label: 'Glow Tip B',   group: 'Scene Colors', isColor: 'goldenTipColor', ch: 'b' },
			// Scene Colors — green tip (renamed: deep tip)
			greenTipR:  { def: 0.020, min: 0, max: 1, step: 0.01, label: 'Deep Tip R',   group: 'Scene Colors', isColor: 'greenTipColor', ch: 'r' },
			greenTipG:  { def: 0.220, min: 0, max: 1, step: 0.01, label: 'Deep Tip G',   group: 'Scene Colors', isColor: 'greenTipColor', ch: 'g' },
			greenTipB:  { def: 0.380, min: 0, max: 1, step: 0.01, label: 'Deep Tip B',   group: 'Scene Colors', isColor: 'greenTipColor', ch: 'b' },
			// Scene Colors — mid tone
			midR:       { def: 0.014, min: 0, max: 1, step: 0.01, label: 'Mid Tone R',   group: 'Scene Colors', isColor: 'midColor', ch: 'r' },
			midG:       { def: 0.095, min: 0, max: 1, step: 0.01, label: 'Mid Tone G',   group: 'Scene Colors', isColor: 'midColor', ch: 'g' },
			midB:       { def: 0.180, min: 0, max: 1, step: 0.01, label: 'Mid Tone B',   group: 'Scene Colors', isColor: 'midColor', ch: 'b' },
			// Color variation
			colorVar:   { u: bladeColorVariation, def: 0.93, min: 0, max: 1, step: 0.01, label: 'Color Var', group: 'Scene Colors' },
		};

		const stageParamKeys = Object.keys(stageParamDefs);

		// Color uniform lookup for applying interpolated color channels
		const colorUniformMap = {
			fogColor: fogColor,
			bladeBaseColor: bladeBaseColor,
			bladeTipColor: bladeTipColor,
			goldenTipColor: goldenTipColor,
			greenTipColor: greenTipColor,
			midColor: midColor,
		};

		// Build default params object — reads current uniform values for colors
		function getDefaultParams() {
			const p = {};
			stageParamKeys.forEach(k => {
				const d = stageParamDefs[k];
				if (d.isColor && d.ch) {
					// Pull actual current value from the uniform
					const cu = colorUniformMap[d.isColor];
					if (cu) {
						p[k] = cu.value[d.ch];
					} else {
						p[k] = d.def;
					}
				} else {
					p[k] = d.def;
				}
			});
			return p;
		}

		// Per-stage camera path with full DoF settings
		// [scroll, posX, posY, posZ, lookX, lookY, lookZ, focusDist, autoFocus, dofOn, focalLen, bokehScale, afSpeed, afMin, afMax]
		//  0       1     2     3     4      5      6      7          8          9      10        11          12       13     14
		const cameraPath = [
			[0.00, -2.8,  7.2, 19.6,  0.5, 1.5,  0.4, 22.0, 1, 1, 10.0, 12.5, 5.0, 1.0, 40.0],  // Hero
			[0.14,  0,    2.2, 14.0,  0,  -2.0,   0,   15.0, 1, 1,  8.0, 10.0, 5.0, 1.0, 30.0],  // Manifesto
			[0.28,  7.5, 10.9, 15.8,  0,   0.0,   0.7, 10.0, 1, 1,  6.0,  8.0, 5.0, 0.5, 20.0],  // Pillars
			[0.43, -8.0,  6.8, 21.6,  0,   0.2,   0,    7.0, 1, 1,  5.0, 10.0, 5.0, 0.5, 15.0],  // Stats
			[0.57, -1.0,  5.3, 25.0, -1.2, 3.0,   0,    5.0, 1, 1,  4.0, 14.0, 6.0, 1.1, 21.5],  // Quote
			[0.78, -1.6,  2.4,  0.0, -1.2, -2.0,   0.0, 16.4, 1, 0, 20.0, 18.0, 19.0, 2.8, 12.5],  // CTA
			[1.00,  0,   15.0,  0.0, -5,   3.0,  -5,    9.8, 1, 1, 13.8,  0.0, 17.5, 1.2,  9.0],  // Footer
		];

		// Per-stage params (each stage gets its own copy, starts as defaults)
		const stageParams = cameraPath.map(() => getDefaultParams());

		// Apply exported per-stage overrides
		(function applyExportedParams() {
			const exported = [
				// Hero (0) — deep ocean blues
				{ bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78, goldenTipR:0.06, goldenTipG:0.50, goldenTipB:0.72, greenTipR:0.02, greenTipG:0.22, greenTipB:0.38, midR:0.014, midG:0.095, midB:0.18 },
				// Manifesto (1) — slightly brighter
				{ bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78, goldenTipR:0.06, goldenTipG:0.50, goldenTipB:0.72, greenTipR:0.02, greenTipG:0.22, greenTipB:0.38, midR:0.014, midG:0.095, midB:0.18 },
				// Pillars (2) — cool teal-silver palette
				{ bladeBaseR:0, bladeBaseG:0.05, bladeBaseB:0.12, bladeTipR:0.75, bladeTipG:0.92, bladeTipB:0.97, goldenTipR:0.20, goldenTipG:0.70, goldenTipB:0.88, greenTipR:0.04, greenTipG:0.30, greenTipB:0.50, midR:0.008, midG:0.055, midB:0.12, colorVar:1 },
				// Stats (3) — rippling mid-depth
				{ fogStart:0, fogEnd:12.5, bladeHeight:2, bladeHeightVar:1, bladeLean:0, windSpeed:1.3, windAmplitude:0.21, bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78, goldenTipR:0.06, goldenTipG:0.50, goldenTipB:0.72, greenTipR:0.02, greenTipG:0.22, greenTipB:0.38, midR:0.014, midG:0.095, midB:0.18 },
				// Quote (4) — luminous deep
				{ bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78, goldenTipR:0.06, goldenTipG:0.50, goldenTipB:0.72, greenTipR:0.02, greenTipG:0.22, greenTipB:0.38, midR:0.014, midG:0.095, midB:0.18 },
				// CTA (5) — short kelp-like, teal shift
				{ fogStart:7, bladeTipWidth:0.27, bladeHeight:0.9, bladeHeightVar:0, bladeLean:0, bladeBaseR:0.008, bladeBaseG:0.047, bladeBaseB:0.094, bladeTipR:0.09, bladeTipG:0.62, bladeTipB:0.78, goldenTipR:0.06, goldenTipG:0.50, goldenTipB:0.72, greenTipR:0.02, greenTipG:0.22, greenTipB:0.38, midR:0.014, midG:0.095, midB:0.18 },
				// Footer (6) — abyss fade
				{ fogStart:2, fogEnd:10, bladeHeight:2, bladeHeightVar:0, bladeLean:0, windSpeed:1.3, windAmplitude:0.21, bladeBaseR:0, bladeBaseG:0.028, bladeBaseB:0.07, bladeTipR:0.05, bladeTipG:0.35, bladeTipB:0.50, goldenTipR:0.04, goldenTipG:0.28, goldenTipB:0.42, greenTipR:0.01, greenTipG:0.12, greenTipB:0.22, midR:0, midG:0, midB:0 },
			];
			exported.forEach((overrides, i) => {
				Object.keys(overrides).forEach(k => {
					if (k in stageParams[i]) stageParams[i][k] = overrides[k];
				});
			});
		})();

		function lerpCam(scrollT) {
			// Snap to nearest keyframe if very close (within 0.5% of scroll range)
			const snapThreshold = 0.005;
			for (let j = 0; j < cameraPath.length; j++) {
				if (Math.abs(cameraPath[j][0] - scrollT) < snapThreshold) {
					const kf = cameraPath[j];
					return {
						px: kf[1], py: kf[2], pz: kf[3],
						lx: kf[4], ly: kf[5], lz: kf[6],
						fd: kf[7], af: kf[8], dofOn: kf[9],
						fl: kf[10], bk: kf[11],
						afSpd: kf[12], afMin: kf[13], afMax: kf[14],
						params: { ...stageParams[j] },
					};
				}
			}

			let i = 0;
			for (let j = 1; j < cameraPath.length; j++) {
				if (cameraPath[j][0] >= scrollT) { i = j - 1; break; }
				if (j === cameraPath.length - 1) i = j - 1;
			}
			const a = cameraPath[i], b = cameraPath[Math.min(i + 1, cameraPath.length - 1)];
			const range = b[0] - a[0];
			const t = range > 0 ? Math.max(0, Math.min(1, (scrollT - a[0]) / range)) : 0;
			const ease = t * t * (3 - 2 * t);

			// Interpolate per-stage params
			const iB = Math.min(i + 1, cameraPath.length - 1);
			const pA = stageParams[i], pB = stageParams[iB];
			const lerpedParams = {};
			stageParamKeys.forEach(k => {
				lerpedParams[k] = pA[k] + (pB[k] - pA[k]) * ease;
			});

			return {
				px: a[1] + (b[1] - a[1]) * ease,
				py: a[2] + (b[2] - a[2]) * ease,
				pz: a[3] + (b[3] - a[3]) * ease,
				lx: a[4] + (b[4] - a[4]) * ease,
				ly: a[5] + (b[5] - a[5]) * ease,
				lz: a[6] + (b[6] - a[6]) * ease,
				fd: a[7] + (b[7] - a[7]) * ease,
				af: a[8] + (b[8] - a[8]) * ease,
				dofOn: a[9] + (b[9] - a[9]) * ease,
				fl: a[10] + (b[10] - a[10]) * ease,
				bk: a[11] + (b[11] - a[11]) * ease,
				afSpd: a[12] + (b[12] - a[12]) * ease,
				afMin: a[13] + (b[13] - a[13]) * ease,
				afMax: a[14] + (b[14] - a[14]) * ease,
				params: lerpedParams,
			};
		}

		let currentScrollT = 0;
		let targetScrollT = 0;

		
		function getScrollProgress() {
			const container = document.querySelector('.home-content-scroll') || document.documentElement;
			const scrollTop = container.scrollTop || window.pageYOffset;
			const docHeight = container.scrollHeight;
			const winHeight = container.clientHeight || window.innerHeight;
			const scrollable = docHeight - winHeight;
			return scrollable > 0 ? Math.min(1, Math.max(0, scrollTop / scrollable)) : 0;
		}

		const container = document.querySelector('.home-content-scroll');
		if (container) {
			container.addEventListener('scroll', () => { _scrollDirty = true; }, { passive: true });
		}


		// Sync cameraPath scroll values to actual DOM section positions
		function syncCameraPathToDOM() { /* Neutered to preserve raw scroll percentages for ALACADO */ }"]`);
				if (section) {
					const sectionTop = section.offsetTop;
					kf[0] = Math.min(1, Math.max(0, sectionTop / scrollable));
				}
			});
			// Ensure footer (last) is always 1.0
			cameraPath[cameraPath.length - 1][0] = 1.0;
		}

		// Sync on load and on resize
		syncCameraPathToDOM();
		window.addEventListener('resize', () => {
			setTimeout(syncCameraPathToDOM, 100);
		});
		// Re-sync after fonts/images load
		window.addEventListener('load', () => {
			setTimeout(syncCameraPathToDOM, 200);
			setTimeout(syncCameraPathToDOM, 1000);
		});

		let _scrollDirty = false;
		window.addEventListener('scroll', () => { _scrollDirty = true; }, { passive: true });
		window.addEventListener('touchmove', () => { _scrollDirty = true; }, { passive: true });

		// ─── Reveal on Scroll ──────────────────────────────────────────────
		const progressBar = document.getElementById('progressBar');
		const navFloat = document.getElementById('navFloat');

		// Use IntersectionObserver for reveals — no per-scroll layout thrashing
		const revealObserver = new IntersectionObserver((entries) => {
			entries.forEach(entry => {
				if (entry.isIntersecting) {
					const el = entry.target;
					const delay = el.dataset.delay || '0';
					el.classList.add('revealed', `delay-${delay}`);
					revealObserver.unobserve(el);
				}
			});
		}, { threshold: 0.1, rootMargin: '0px 0px -18% 0px' });

		document.querySelectorAll('[data-reveal]').forEach(el => revealObserver.observe(el));

		// Force reveal the scroll hint after a brief delay
		setTimeout(() => {
			const hint = document.querySelector('.scroll-hint');
			if (hint && !hint.classList.contains('revealed')) {
				hint.classList.add('revealed', 'delay-4');
			}
		}, 800);

		// ─── Nav Link Click → Scroll to Section ────────────────────────────
		document.querySelectorAll('[data-nav]').forEach(link => {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const stageIdx = parseInt(link.dataset.nav);
				const section = document.querySelector(`.section[data-stage="${stageIdx}"]`);
				if (section) {
					section.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
			});
		});

		// ─── Mobile Hamburger Menu ─────────────────────────────────────────
		const navHamburger = document.getElementById('navHamburger');
		const navMobileOverlay = document.getElementById('navMobileOverlay');

		navHamburger.addEventListener('click', () => {
			navHamburger.classList.toggle('open');
			navMobileOverlay.classList.toggle('open');
		});

		document.querySelectorAll('[data-nav-mobile]').forEach(link => {
			link.addEventListener('click', (e) => {
				e.preventDefault();
				const stageIdx = parseInt(link.dataset.navMobile);
				const section = document.querySelector(`.section[data-stage="${stageIdx}"]`);
				navHamburger.classList.remove('open');
				navMobileOverlay.classList.remove('open');
				if (section) {
					section.scrollIntoView({ behavior: 'smooth', block: 'start' });
				}
			});
		});

		// ─── Build settings now that cameraPath is defined ─────────────────
		buildSettings();

		// ─── Boot ──────────────────────────────────────────────────────────
		await renderer.computeAsync(computeInit);

		// Pre-warm the pipeline by rendering a couple of frames before showing
		renderer.domElement.style.opacity = '0';
		renderer.domElement.style.transition = 'opacity 0.4s ease';
		for (let i = 0; i < 3; i++) {
			renderer.compute(computeUpdate);
			postProcessing.render();
			await new Promise(r => requestAnimationFrame(r));
		}
		renderer.domElement.style.opacity = '1';

		const clock = new THREE.Clock();
		const lookTarget = new THREE.Vector3();

		// Cache DOM elements queried every frame
		const _siteFooter = document.querySelector('.site-footer');
		const _scrollHint = document.querySelector('.scroll-hint');

		function animate() {
			const dt = Math.min(clock.getDelta(), 0.05);

			if (_scrollDirty) {
				targetScrollT = getScrollProgress();
				_scrollDirty = false;
			}

			// Smooth scroll interpolation
			currentScrollT += (targetScrollT - currentScrollT) * Math.min(1, dt * 6);

			// If a camera path stage is being edited, snap to that keyframe directly
			const override = window._getCameraOverride ? window._getCameraOverride() : -1;
			let cam;
			if (override >= 0 && override < cameraPath.length) {
				const kf = cameraPath[override];
				cam = {
					px: kf[1], py: kf[2], pz: kf[3],
					lx: kf[4], ly: kf[5], lz: kf[6],
					fd: kf[7], af: kf[8], dofOn: kf[9],
					fl: kf[10], bk: kf[11],
					afSpd: kf[12], afMin: kf[13], afMax: kf[14],
					params: stageParams[override],
				};
			} else {
				cam = lerpCam(currentScrollT);
			}
			camera.position.set(cam.px, cam.py, cam.pz);
			lookTarget.set(cam.lx, cam.ly, cam.lz);
			camera.lookAt(lookTarget);

			// Push canvas up when footer is visible (cached element)
			if (_siteFooter) {
				const footerTop = _siteFooter.getBoundingClientRect().top;
				if (footerTop < window.innerHeight) {
					renderer.domElement.style.transform = `translateY(-${window.innerHeight - footerTop}px)`;
				} else {
					renderer.domElement.style.transform = '';
				}
			}

			// Progress bar
			progressBar.style.width = (currentScrollT * 100) + '%';

		// Nav visibility
		navFloat.classList.toggle('visible', currentScrollT > 0.08);

		// Fade out scroll hint on scroll (cached element)
		if (_scrollHint) {
			_scrollHint.style.opacity = Math.max(0, 1 - currentScrollT * 15);
		}

			// Camera sphere — always push grass away from camera base
			camSphereWorld.value.set(camera.position.x, 0, camera.position.z);

			// Apply interpolated per-stage params to uniforms
			if (cam.params) {
				const p = cam.params;
				// Fog
				fogStart.value = p.fogStart;
				fogEnd.value = p.fogEnd;
				fogIntensity.value = p.fogIntensity;
				fogColor.value.setRGB(p.fogR, p.fogG, p.fogB);
				if (scene.fog) scene.fog.color.setRGB(p.fogR, p.fogG, p.fogB);
				// Grass
				grassDensity.value = p.grassDensity;
				bladeWidth.value = p.bladeWidth;
				bladeTipWidth.value = p.bladeTipWidth;
				bladeHeight.value = p.bladeHeight;
				bladeHeightVariation.value = p.bladeHeightVar;
				bladeLean.value = p.bladeLean;
				// Wind (base values before burst)
				_baseWindSpeed = p.windSpeed;
				_baseWindAmp = p.windAmplitude;
				// Noise
				noiseAmplitude.value = p.noiseAmp;
				noiseFrequency.value = p.noiseFreq;
				noise2Amplitude.value = p.noise2Amp;
				noise2Frequency.value = p.noise2Freq;
				// Mouse
				mouseRadius.value = p.mouseRadius;
				mouseStrength.value = p.mouseStrength;
				outerRadius.value = p.outerRadius;
				outerStrength.value = p.outerStrength;
				// Scene Colors
				bladeBaseColor.value.setRGB(p.bladeBaseR, p.bladeBaseG, p.bladeBaseB);
				bladeTipColor.value.setRGB(p.bladeTipR, p.bladeTipG, p.bladeTipB);
				goldenTipColor.value.setRGB(p.goldenTipR, p.goldenTipG, p.goldenTipB);
				greenTipColor.value.setRGB(p.greenTipR, p.greenTipG, p.greenTipB);
				midColor.value.setRGB(p.midR, p.midG, p.midB);
				bladeColorVariation.value = p.colorVar;
				// Camera Sphere — blend per-stage values with proximity scaling
				const baseCamR = p.camSphereRadius;
				const baseCamS = p.camSphereStrength;
				camSphereRadius.value = baseCamR;
				camSphereStrength.value = baseCamS;
			}

			// Scale camera sphere influence additionally based on proximity to grass
			const camHeight = camera.position.y;
			const proximityT = Math.max(0, 1 - camHeight / 10);
			const proxCurve = proximityT * proximityT;
			// Add proximity boost on top of per-stage base
			camSphereRadius.value = Math.min(15, camSphereRadius.value * (0.3 + proxCurve * 0.7));
			camSphereStrength.value = camSphereStrength.value * (0.1 + proxCurve * 0.9);

			// Always apply base wind from per-stage params, then layer burst on top
			windSpeed.value = _baseWindSpeed;
			windAmplitude.value = _baseWindAmp;

			// Wind burst — smoothly ramp up speed & amplitude, then ease back down
			if (windBurst > 0) {
				windBurst -= dt * 0.6;
				const burstT = Math.max(0, windBurst / 4.0);
				const eased = burstT * burstT * (3 - 2 * burstT);
				windSpeed.value += eased * 4.5;
				windAmplitude.value += eased * 0.45;
			}

			// Per-stage DoF
			{
				const dofWeight = typeof cam.dofOn === 'number' ? cam.dofOn : 1;
				const shouldDof = globalDofEnabled && dofWeight > 0.5;

				// Toggle DoF pipeline if state changed
				if (shouldDof !== dofEnabled) {
					dofEnabled = shouldDof;
					rebuildPipeline();
				}

				if (dofEnabled) {
					const autoWeight = typeof cam.af === 'number' ? Math.max(0, Math.min(1, cam.af)) : 0;
					const mouseOnField = mouseWorld.value.x < 9000;
					const afSpeed = cam.afSpd || 5.0;
					const afMin = cam.afMin || 0.5;
					const afMax = cam.afMax || 40.0;

					// Compute raw auto-focus distance from mouse
					let rawAutoFocus;
					if (mouseOnField) {
						rawAutoFocus = mouseFocusDist;
					} else {
						rawAutoFocus = Math.max(0.5, Math.sqrt(cam.py * cam.py + cam.pz * cam.pz) * 0.9);
					}

					// Clamp to per-stage AF range
					rawAutoFocus = Math.max(afMin, Math.min(afMax, rawAutoFocus));

					// Smooth auto-focus with per-stage speed
					autoFocusSmoothed += (rawAutoFocus - autoFocusSmoothed) * Math.min(1, dt * afSpeed);

					// Blend between manual focus and auto-focus
					const targetFocus = cam.fd * (1 - autoWeight) + autoFocusSmoothed * autoWeight;

					focusDistanceU.value += (targetFocus - focusDistanceU.value) * Math.min(1, dt * 8);
					focalLengthU.value += (cam.fl - focalLengthU.value) * Math.min(1, dt * 6);
					bokehScaleU.value += (cam.bk - bokehScaleU.value) * Math.min(1, dt * 6);
				}

				// Update the active stage's focus distance display if in auto mode
				const ovr = window._getCameraOverride ? window._getCameraOverride() : -1;
				if (ovr >= 0 && cameraPath[ovr][8] && dofEnabled) {
					const fdEl = document.getElementById(`cp_${ovr}_fd_v`);
					if (fdEl) fdEl.textContent = focusDistanceU.value.toFixed(1);
				}
			}

			// FPS counter
			fpsFrames++;
			const fpsNow = performance.now();
			if (fpsNow - fpsLast >= 500) {
				if (fpsEnabled && fpsOverlay) {
					fpsOverlay.textContent = (fpsFrames / ((fpsNow - fpsLast) / 1000)).toFixed(0) + ' FPS';
				}
				fpsFrames = 0;
				fpsLast = fpsNow;
			}

			renderer.compute(computeUpdate);
			postProcessing.render();
		}

		renderer.setAnimationLoop(animate);
	