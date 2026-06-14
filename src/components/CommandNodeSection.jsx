import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const queries = [
  "> Sourcing: Lead React Architect for Fintech MVP",
  "> Sourcing: Elite Catering for 500-Guest Gala",
  "> Sourcing: Brutalist Brand Identity & UI Design"
];

export default function CommandNodeSection() {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % queries.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative w-full min-h-screen bg-black flex flex-col items-center justify-center px-8 py-32 z-20">
      
      {/* The Ethos Text Reveal */}
      <motion.p
        initial={{ opacity: 0, filter: 'blur(10px)', y: 40 }}
        whileInView={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
        viewport={{ once: false, amount: 0.3 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
        className="text-2xl md:text-4xl text-gray-400 font-light max-w-4xl text-center leading-relaxed mb-24"
      >
        "The market is loud. Talent is hidden. We operate in the quiet space between the problem and the execution. Tell the engine what you need."
      </motion.p>

      {/* The Command Node Search Bar */}
      <input 
        type="text" 
        placeholder="Type your objective..." 
        className="w-full max-w-3xl bg-transparent border-b-2 border-white/20 text-white text-3xl md:text-5xl py-4 px-2 focus:outline-none focus:border-[#c19a6b] transition-colors placeholder:text-white/20 font-light text-center"
      />

      {/* Live Queries Feed */}
      <div className="h-6 mt-6 overflow-hidden relative w-full flex justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentIndex}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.5 }}
            className="text-[#c19a6b]/60 font-mono text-sm tracking-widest uppercase absolute"
          >
            {queries[currentIndex]}
          </motion.div>
        </AnimatePresence>
      </div>

    </section>
  );
}
