/**
 * Starter circuits. Each one is real CircuiTikZ source, so loading an example
 * exercises the same parser a pasted-in diagram goes through.
 */

export interface CircuitExample {
    id: string;
    name: string;
    description: string;
    code: string;
}

const doc = (body: string, style: "american" | "european" = "american") =>
    `\\documentclass[border=6pt]{standalone}
\\usepackage[${style}]{circuitikz}
\\begin{document}
\\begin{circuitikz}[line width=0.8pt]
${body.trim()}
\\end{circuitikz}
\\end{document}
`;

export const EXAMPLES: CircuitExample[] = [
    {
        id: "bridge",
        name: "Bridge network",
        description: "Four resistors in a diamond with a bridging arm, fed by a cell.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (P) at (2,1.7);
\coordinate (B) at (4,0);
\coordinate (Q) at (2,-1.7);
\draw (A) to[R,l=$3\,\Omega$] (P) to[R,l=$6\,\Omega$] (B);
\draw (A) to[R,l=$6\,\Omega$] (Q) to[R,l=$3\,\Omega$] (B);
\draw (P) to[R,l=$4\,\Omega$] (Q);
\draw (A) -- (-0.5,0) -- (-0.5,-2.6) to[battery1,l=$12\,\mathrm{V}$] (4.5,-2.6) -- (4.5,0) -- (B);
\node[left] at (A) {$A$};
\node[right] at (B) {$B$};
\node[above] at (P) {$P$};
\node[below] at (Q) {$Q$};
\node[above=2pt] at (-0.5,-2.6) {$+$};
\node[above=2pt] at (4.5,-2.6) {$-$};`),
    },
    {
        id: "series",
        name: "Series circuit",
        description: "Cell, resistor, ammeter and a key in one loop.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (B) at (4,0);
\coordinate (C) at (4,-2.5);
\coordinate (D) at (0,-2.5);
\draw (A) to[R,l=$R$] (B);
\draw (B) to[ammeter] (C);
\draw (C) to[ospst] (D);
\draw (D) to[battery1,l=$\varepsilon$] (A);`),
    },
    {
        id: "parallel",
        name: "Resistors in parallel",
        description: "Two parallel resistors across a battery.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (B) at (3,0);
\coordinate (C) at (3,-2);
\coordinate (D) at (0,-2);
\coordinate (E) at (-2,0);
\coordinate (F) at (-2,-2);
\draw (A) to[R,l=$R_1$] (B);
\draw (D) to[R,l=$R_2$] (C);
\draw (A) -- (D);
\draw (B) -- (C);
\draw (A) -- (E) to[battery2,l=$V$] (F) -- (D);`),
    },
    {
        id: "wheatstone",
        name: "Wheatstone bridge",
        description: "Balanced bridge with a galvanometer in the middle arm.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (B) at (2.2,1.8);
\coordinate (C) at (4.4,0);
\coordinate (D) at (2.2,-1.8);
\draw (A) to[R,l=$P$] (B);
\draw (B) to[R,l=$Q$] (C);
\draw (A) to[R,l_=$R$] (D);
\draw (D) to[R,l_=$S$] (C);
\draw (B) to[rmeter,t=$G$] (D);
\draw (A) -- (-1,0) -- (-1,-3.2) to[battery1,l=$E$] (5.4,-3.2) -- (5.4,0) -- (C);
\node[left] at (A) {$A$};
\node[above] at (B) {$B$};
\node[right] at (C) {$C$};
\node[below] at (D) {$D$};`),
    },
    {
        id: "lcr",
        name: "Series LCR (AC)",
        description: "Inductor, capacitor and resistor driven by an AC source.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (B) at (2,0);
\coordinate (C) at (4,0);
\coordinate (D) at (6,0);
\coordinate (E) at (6,-2.6);
\coordinate (F) at (0,-2.6);
\draw (A) to[L,l=$L$] (B) to[C,l=$C$] (C) to[R,l=$R$] (D);
\draw (D) -- (E);
\draw (E) to[sV,l_=$\sim$] (F);
\draw (F) -- (A);`),
    },
    {
        id: "rc-ground",
        name: "RC with ground",
        description: "A source, resistor and capacitor with an earthed return.",
        code: doc(String.raw`\coordinate (A) at (0,0);
\coordinate (B) at (2.5,0);
\coordinate (C) at (2.5,-2);
\coordinate (D) at (0,-2);
\draw (A) to[R,l=$R$] (B);
\draw (B) to[C,l=$C$] (C);
\draw (D) to[V,l=$V_0$] (A);
\draw (C) -- (D);
\draw (D) to[short] (-1.4,-2) node[ground]{};`),
    },
];

export const DEFAULT_EXAMPLE_ID = "bridge";
