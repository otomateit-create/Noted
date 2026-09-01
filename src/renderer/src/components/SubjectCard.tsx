/*
 * La carte d'une matiere, sur le tableau de bord.
 *
 * Du papier teinte, translucide : le fond de la carte est un lavis de la
 * teinte de la matiere, assez transparent pour que le papier pointille de la
 * plaque se voie a travers. Le titre est l'encre de la meme teinte, le symbole
 * de la famille son ton moyen — tout est ton sur ton, rien n'est colore.
 *
 * Le mouvement est celui de l'ancienne carte 3D (21st.dev) : l'inclinaison
 * suit la souris, un reflet diagonal balaie la carte a l'angle ou elle penche,
 * le point pulse. Seule la robe a change.
 *
 * Deux details tiennent la carte stable sous la souris :
 *
 * - La souris est ecoutee par un socle immobile, de la taille exacte de la
 *   carte au repos, et c'est son rectangle qui sert au calcul. Ecoutee par la
 *   carte elle-meme, l'inclinaison faisait reculer le bord survole de quelques
 *   pixels, le curseur se retrouvait dehors, la carte se redressait, il etait
 *   dedans : un tremblement a chaque bord.
 *
 * - Rien ne se repeint pendant le mouvement. Le reflet ne bouge que par
 *   transform et opacity (la bande tourne, elle ne change pas de degrade), et
 *   la carte est un calque a echelle fixe (will-change, dashboard.css). Sans
 *   cela, chaque image redessinait le texte et les symboles a une echelle un
 *   peu differente : les traits grossissaient et maigrissaient comme un neon.
 */

import { useCallback, useState, type ReactNode } from "react";
import { motion, type Variants } from "framer-motion";

/** La cascade d'apparition de la grille : le conteneur, puis chaque tuile. */
export const containerVariants: Variants = {
  hidden: { opacity: 0, scale: 0.98 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.2,
      duration: 0.5,
      ease: [0.23, 1, 0.32, 1],
    },
  },
};

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 40, rotateX: -15, scale: 0.95 },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    scale: 1,
    transition: { type: "spring", stiffness: 100, damping: 12, mass: 0.7 },
  },
};

interface SubjectCardProps {
  title: string;
  description: string;
  /** Le symbole de la famille (subject-theme.tsx). */
  icon: ReactNode;
  /** Angle de teinte oklch (subject-tint.ts). */
  hue: number;
  onOpen: () => void;
}

export default function SubjectCard({
  title,
  description,
  icon,
  hue,
  onOpen,
}: SubjectCardProps): React.JSX.Element {
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [hovered, setHovered] = useState(false);

  const handleMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    // Le rectangle du socle, jamais celui de la carte : inclinee, elle ne
    // mesure plus la meme chose, et le calcul se mordrait la queue.
    const rect = event.currentTarget.getBoundingClientRect();
    // La carte relevee deborde un peu du socle : la souris peut etre sur elle
    // en etant hors du rectangle. On borne, plutot que d'incliner au-dela.
    const x = clamp((event.clientX - rect.left) / rect.width - 0.5);
    const y = clamp((event.clientY - rect.top) / rect.height - 0.5);
    setMouse({ x: x * 25, y: y * -25 });
  }, []);

  const handleLeave = useCallback(() => {
    setHovered(false);
    setMouse({ x: 0, y: 0 });
  }, []);

  return (
    <div
      className="subject-card-slot"
      onMouseMove={handleMove}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={handleLeave}
    >
      <motion.div
        className="subject-card"
        style={
          { "--h": hue, transformPerspective: 1200 } as React.CSSProperties
        }
        animate={{ rotateX: mouse.y, rotateY: mouse.x, z: hovered ? 30 : 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 35, mass: 0.8 }}
        whileTap={{ scale: 0.98, rotateX: mouse.y + 3, rotateY: mouse.x + 3 }}
        onClick={onOpen}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        {/* Le reflet : une bande de lumiere qui traverse la carte a l'angle ou
          elle penche. Le calque deborde de la carte pour que la bande puisse
          la balayer d'un bord a l'autre ; c'est la bande qui tourne, son
          degrade ne change jamais. */}
        <div className="subject-card-sheen" aria-hidden="true">
          <motion.div
            className="subject-card-sheen-band"
            animate={{ rotate: mouse.x, opacity: hovered ? 1 : 0 }}
            transition={{ duration: 0.3 }}
          />
        </div>

        <div className="subject-card-top">
          <motion.div
            className="subject-card-icon"
            animate={{ rotateZ: hovered ? 5 : 0, y: hovered ? -2 : 0 }}
            transition={{ duration: 0.3 }}
          >
            {icon}
          </motion.div>

          <motion.div
            className="subject-card-pulse"
            animate={{ scale: hovered ? 1.2 : 1 }}
            transition={{ duration: 0.3 }}
          >
            <motion.span
              className="subject-card-pulse-ring"
              animate={{
                scale: hovered ? [1, 1.6, 1] : 1,
                opacity: hovered ? [0.6, 0.15, 0.6] : 0,
              }}
              transition={{
                duration: 1.5,
                repeat: hovered ? Infinity : 0,
                ease: "easeInOut",
              }}
            />
          </motion.div>
        </div>

        <motion.div
          className="subject-card-body"
          animate={{ y: hovered ? -3 : 0 }}
          transition={{ duration: 0.3 }}
        >
          <h3 className="subject-card-title">{title}</h3>
          <p className="subject-card-description">{description}</p>
          <motion.div
            className="subject-card-open"
            animate={{ x: hovered ? 0 : -8, opacity: hovered ? 1 : 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            <span className="subject-card-open-dash" />
            Ouvrir
          </motion.div>
        </motion.div>
      </motion.div>
    </div>
  );
}

/** Entre -0,5 et 0,5 : la moitie de la carte, de part et d'autre du centre. */
function clamp(value: number): number {
  return Math.min(0.5, Math.max(-0.5, value));
}
