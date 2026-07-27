/**
 * fakeCosmeticsArticlesRun2.js
 * ===========================
 * SECOND WAVE of 20 fake cosmetics articles — new companies, same 5
 * trend clusters as run 1, meant to be pushed through the Forward
 * Outlook pipeline as a follow-up run so you can watch:
 *   - dot_size grow on already-active trends
 *   - candidate trends that didn't hit promotion in run 1 pick up more
 *     signals and cross the threshold
 *   - a new row land in trend_snapshots per trend on this run's date
 *
 * Vocabulary is kept tightly scoped to each cluster's own terms (no
 * shared boilerplate phrasing across clusters) so signals join their
 * intended trend instead of bleeding into unrelated ones.
 *
 * Run this the same way as the original — swap the require in
 * testForwardOutlookE2E.js from './fakeCosmeticsArticles' to
 * './fakeCosmeticsArticlesRun2', or point a copy of the test script
 * at this file for the second run.
 */

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

const CLUSTERS = [
  {
    name: 'Waterless & Solid Beauty', // Sector: Sustainability | Horizon: near_term
    dayOffsets: [4, 3, 2, 1],
    articles: [
      {
        signalType: 'Innovation',
        title: 'Ethique Launches Compressed Solid Body Wash Bar Line for Grocery Retail',
        text: `Ethique has launched a compressed, water-free solid body wash bar line built for grocery retail shelves, extending its anhydrous bar format beyond specialty beauty stores. The brand says compressed bars now outsell its liquid-format products in every market where both are stocked side by side.`,
      },
      {
        signalType: 'Patent',
        title: 'Lush Files Patent for Dissolving Solid Conditioner Compression Process',
        text: `Lush has filed a patent covering a dissolving compression process used to manufacture its solid conditioner bars, which eliminates the liquid carrier entirely from the conditioner formulation. The filing describes a compression method that increases bar hardness without sacrificing how quickly it dissolves under running water.`,
      },
      {
        signalType: 'Research & Development',
        title: 'Plaine Products Lab Extends Anhydrous Bar Shelf-Stability Testing to Humid Climates',
        text: `Plaine Products' formulation lab has completed shelf-stability testing showing its compressed, water-free bars hold shape and lather performance in high-humidity climates, a barrier that previously limited solid-format haircare to temperate markets. The lab says the results clear the path to compressed-bar distribution in new humid-climate regions.`,
      },
      {
        signalType: 'Capital Investment',
        title: 'Kevin Murphy Raises Growth Funding to Scale Compressed Bar Manufacturing Line',
        text: `Salon-professional haircare brand Kevin Murphy has raised a growth funding round dedicated to scaling a new compressed-bar manufacturing line, converting several of its bestselling liquid shampoos into anhydrous bar format. Investors point to compressed-bar sell-through in salon retail as the deciding factor behind the round.`,
      },
    ],
  },
  {
    name: 'AI Skin Diagnostics & Personalization', // Sector: Technology | Horizon: mid_term
    dayOffsets: [4, 3, 2, 1],
    articles: [
      {
        signalType: 'Innovation',
        title: 'Perfect Corp Launches Camera-Based Skin-Scan Engine for Retail Partners',
        text: `Perfect Corp has launched a camera-based skin-scan diagnostic engine that retail partners can embed directly into their apps, generating a personalized product recommendation from a single facial scan. The company says the scan-to-recommendation engine is being integrated across a growing list of prestige beauty retailers.`,
      },
      {
        signalType: 'Patent',
        title: 'Curology Files Patent for Skin-Scan-Driven Formulation Dosing Algorithm',
        text: `Curology has filed a patent for a formulation-dosing algorithm that adjusts active-ingredient concentration in its custom prescriptions based on skin-scan input rather than a static questionnaire. The filing covers the scan-to-dosage inference model powering the next generation of its diagnostic-driven formulation engine.`,
      },
      {
        signalType: 'Research & Development',
        title: 'Atolla Publishes Study on Skin-Scan Model Accuracy Across Skin Tones',
        text: `Skin-diagnostics startup Atolla has published a study showing meaningful accuracy improvements in its skin-scan classification model across a wider range of skin tones, addressing a known gap in earlier camera-based diagnostic models. The team says the improved model is rolling into its formulation engine this quarter.`,
      },
      {
        signalType: 'Partnership',
        title: 'Neutrogena Partners with Diagnostics Firm to Expand Skin360 Scan Kiosk Network',
        text: `Neutrogena has signed a partnership to expand its Skin360 camera-based scan kiosk network into new pharmacy and department store locations, generating a personalized regimen recommendation from a facial scan in under a minute. The rollout plan targets standard kiosk presence across the retail network within two to three years.`,
      },
    ],
  },
  {
    name: 'Biotech & Fermented Ingredients', // Sector: Supply Chain | Horizon: long_term
    dayOffsets: [4, 3, 2, 1],
    articles: [
      {
        signalType: 'Innovation',
        title: 'Checkerspot Launches Bioreactor-Grown Algae Oil for Skincare Actives',
        text: `Checkerspot has launched a bioreactor-grown algae oil positioned as a lab-cultured alternative to palm- and petrochemical-derived emollients in skincare formulations. The company says its algae strain can be tuned in fermentation tanks to match the exact fatty-acid profile a formulator needs, replacing multiple sourced ingredients with one cultured input.`,
      },
      {
        signalType: 'Patent',
        title: 'Genomatica Files Patent for Fermentation-Derived Cosmetic Emollient Process',
        text: `Genomatica has filed a patent covering a fermentation process that produces a cosmetic-grade emollient from engineered microbes rather than petrochemical feedstock. The filing describes a bioreactor process designed to scale to industrial ingredient volumes for skincare formulators.`,
      },
      {
        signalType: 'Capital Investment',
        title: 'Conagen Raises Funding to Expand Fermentation-Grown Cosmetic Ingredient Capacity',
        text: `Conagen has raised a new funding round to expand bioreactor capacity dedicated to fermentation-grown cosmetic ingredients, including lab-cultured retinol precursors. Investors cite ingredient buyers locking in multi-year fermentation-grown supply contracts as the deciding factor behind the round.`,
      },
      {
        signalType: 'Partnership',
        title: 'Provivi Signs Supply Partnership for Bioreactor-Grown Retinol Precursor',
        text: `Biotech ingredient maker Provivi has signed a supply partnership to provide a bioreactor-grown retinol precursor to a major skincare brand, replacing a petrochemical-synthesized version long used in anti-aging formulations. The contract ramps fermentation-grown volumes over a five-to-seven-year supply transition.`,
      },
    ],
  },
  {
    name: 'Refillable Packaging Systems', // Sector: Consumer | Horizon: mid_term
    dayOffsets: [4, 3, 2, 1],
    articles: [
      {
        signalType: 'Innovation',
        title: 'By Humankind Launches Refillable Deodorant Pod System in Mass Retail',
        text: `By Humankind has launched a refillable deodorant pod system into mass retail, letting shoppers snap in a new scent pod rather than discarding the outer plastic casing. The brand says pod-refill sell-through has outpaced its original single-use format in every store where both are stocked.`,
      },
      {
        signalType: 'Patent',
        title: 'The Body Shop Files Patent for Snap-Lock Refill Pouch Dispensing Mechanism',
        text: `The Body Shop has filed a patent covering a snap-lock dispensing mechanism used in its refill pouch stations, which lets shoppers refill a reusable bottle from a wall-mounted pouch dispenser rather than buying a new bottle. The filing describes a locking mechanism designed for high-frequency in-store refill traffic.`,
      },
      {
        signalType: 'Capital Investment',
        title: 'Aveda Invests in New Refill Pouch Production Line to Expand Salon Refill Program',
        text: `Aveda has committed new capital investment to build a dedicated refill-pouch production line, expanding its in-salon refill program for shampoo and conditioner to a wider network of professional salons. The brand expects pouch-refill availability to reach standard presence across its salon network within two to three years.`,
      },
      {
        signalType: 'Partnership',
        title: 'Davines Partners with Reusable Packaging Platform to Launch Refill Stations in Italy',
        text: `Davines has signed a partnership with a reusable packaging platform to launch in-store refill stations across Italian salons and retailers, letting customers refill haircare bottles directly rather than purchasing new packaging. The rollout targets standard shelf presence across Italian prestige haircare retail within two to three years.`,
      },
    ],
  },
  {
    name: 'Scalp Care / Skinification', // Sector: Product | Horizon: long_term
    dayOffsets: [4, 3, 2, 1],
    articles: [
      {
        signalType: 'Patent',
        title: 'Act+Acre Files Patent for Cold-Processed Scalp Serum Formulation Method',
        text: `Act+Acre has filed a patent for a cold-processed formulation method used in its scalp serum line, designed to preserve active-ingredient potency the way a dermatologist-grade topical is manufactured rather than a standard haircare product. The filing positions cold-processing as core to the brand's scalp-first formulation approach.`,
      },
      {
        signalType: 'Research & Development',
        title: 'Vegamour Publishes Clinical Study Linking Scalp Serum Use to Follicle Density Gains',
        text: `Vegamour has published a clinical study linking sustained use of its scalp serum to measurable follicle density gains over a twelve-week period, using dermatologist-style imaging protocols to score results. The team frames the clinical data as validation of a diagnose-then-treat approach to scalp health.`,
      },
      {
        signalType: 'Capital Investment',
        title: 'Bumble and Bumble Invests in Dedicated Scalp Care Sub-Brand Launch', 
        text: `Bumble and Bumble has committed new capital investment to launch a dedicated scalp care sub-brand, treating the scalp as its own formulation category the way a skincare line treats facial skin. The brand frames the sub-brand launch as the foundation of a multi-year rebuild of its haircare portfolio around scalp health.`,
      },
      {
        signalType: 'Partnership',
        title: 'Philip Kingsley Partners with Trichology Clinics on Scalp Diagnostic Protocol',
        text: `Philip Kingsley has signed a partnership with a network of trichology clinics to co-develop a scalp diagnostic protocol, applying clinical trichologist assessment methods to its in-store scalp consultations. The brand frames the trichology partnership as a multi-year shift toward diagnostic-led scalp treatment plans reshaping haircare over the next five-plus years.`,
      },
    ],
  },
];

const generateFakeArticles = () => {
  const articles = [];

  for (const cluster of CLUSTERS) {
    cluster.articles.forEach((article, i) => {
      articles.push({
        title: article.title,
        url: `https://example-news.test/cosmetics/run2-${cluster.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i + 1}`,
        text: article.text,
        publishedDate: daysAgo(cluster.dayOffsets[i]),
        author: 'Staff Writer',
      });
    });
  }

  return articles; // 5 clusters x 4 articles = 20
};

module.exports = { generateFakeArticles };