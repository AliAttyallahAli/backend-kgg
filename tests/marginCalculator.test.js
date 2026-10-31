// backend/tests/marginCalculator.test.js
const {
  calcUnitMargin,
  calcCommandeMargin,
} = require('../services/marginCalculator');

describe('marginCalculator', () => {
  describe('calcUnitMargin', () => {
    test('calcule correctement la marge', () => {
      expect(calcUnitMargin(3500, 4500)).toBe(1000);
      expect(calcUnitMargin(1200, 1600)).toBe(400);
    });

    test('accepte marge = 0 (prix égaux)', () => {
      expect(calcUnitMargin(1000, 1000)).toBe(0);
    });

    test('rejette prix vente < prix partenaire', () => {
      expect(() => calcUnitMargin(5000, 3000)).toThrow(/supérieur ou égal/);
    });

    test('rejette prix négatifs', () => {
      expect(() => calcUnitMargin(-100, 500)).toThrow(/négatifs/);
      expect(() => calcUnitMargin(100, -500)).toThrow(/négatifs/);
    });

    test('rejette valeurs non numériques', () => {
      expect(() => calcUnitMargin('1000', 2000)).toThrow(/numériques/);
    });
  });

  describe('calcCommandeMargin', () => {
    test('calcule la marge totale sur plusieurs lignes', () => {
      const lignes = [
        { quantite: 2, prix_partenaire_applique: 3500, prix_vente_applique: 4500 },
        { quantite: 3, prix_partenaire_applique: 1200, prix_vente_applique: 1600 },
      ];
      const r = calcCommandeMargin(lignes);

      expect(r.total_partenaire).toBe(2 * 3500 + 3 * 1200); // 7000 + 3600 = 10600
      expect(r.total_vente).toBe(2 * 4500 + 3 * 1600);       // 9000 + 4800 = 13800
      expect(r.total_marge).toBe(13800 - 10600);             // 3200
      expect(r.marge_pourcentage).toBe(23.19);               // 3200/13800*100
    });

    test('rejette tableau vide non fourni', () => {
      expect(() => calcCommandeMargin(null)).toThrow(/tableau/);
    });

    test('rejette ligne avec prix vente < partenaire', () => {
      expect(() =>
        calcCommandeMargin([
          { quantite: 1, prix_partenaire_applique: 5000, prix_vente_applique: 3000 },
        ])
      ).toThrow(/prix de vente < prix partenaire/);
    });

    test('rejette quantité 0 ou négative', () => {
      expect(() =>
        calcCommandeMargin([
          { quantite: 0, prix_partenaire_applique: 1000, prix_vente_applique: 2000 },
        ])
      ).toThrow(/invalide/);
    });

    test('marge 0 quand prix égaux', () => {
      const r = calcCommandeMargin([
        { quantite: 5, prix_partenaire_applique: 1000, prix_vente_applique: 1000 },
      ]);
      expect(r.total_marge).toBe(0);
      expect(r.marge_pourcentage).toBe(0);
    });
  });
});