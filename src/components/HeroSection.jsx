import DarkVeil from './DarkVeil';

export default function HeroSection() {
  return (
    <div className="relative w-full h-screen bg-black overflow-hidden flex items-center justify-start">
      {/* Background Layer (DarkVeil Shader with gold-bronze shift) */}
      <div className="absolute inset-0 z-0 opacity-60">
        <DarkVeil 
          hueShift={130}
          noiseIntensity={0.08}
          speed={0.3}
          scanlineIntensity={0.2}
          scanlineFrequency={150}
          warpAmount={0.1}
          resolutionScale={0.75}
        />
      </div>

      {/* Foreground Typography */}
      <div className="relative z-10 flex flex-col items-start max-w-5xl px-8 md:px-16">
        <h1 className="font-light text-white tracking-wide leading-tight text-5xl md:text-7xl">
          Tell us <span className="italic text-[#c19a6b]">what</span> you need.<br />
          We connect <span className="italic text-[#c19a6b]">you</span> with the <span className="font-medium text-[#c19a6b]">RIGHT PEOPLE.</span>
        </h1>
        
        <span className="mt-8 text-gray-500 tracking-[0.3em] text-sm uppercase">
          CREATIVE NETWORK — ALACADO
        </span>

        {/* The Two Keys (Routing Buttons) */}
        <div className="flex flex-wrap gap-6 mt-10">
          <button className="px-8 py-4 border border-[#c19a6b] text-[#c19a6b] bg-transparent uppercase tracking-widest text-xs font-semibold transition-all duration-300 hover:bg-[#c19a6b] hover:text-black">
            [ INITIATE A PROJECT ]
          </button>
          
          <button className="px-8 py-4 border border-white/20 text-white bg-transparent uppercase tracking-widest text-xs font-semibold transition-all duration-300 hover:border-white hover:bg-white/5">
            [ JOIN THE NETWORK ]
          </button>
        </div>
      </div>
    </div>
  );
}
