/**
 * Tipos de la base de datos Supabase.
 * Reemplaza este archivo automáticamente con:
 *   npx supabase gen types typescript --project-id <id> > src/types/supabase.ts
 * Esta versión refleja exactamente el esquema definido en supabase/migrations/0001_initial.sql.
 */

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      companies: {
        Row: { id: string; owner_id: string; nombre: string; nit: string | null; nrc: string | null; created_at: string };
        Insert: { id?: string; owner_id: string; nombre: string; nit?: string | null; nrc?: string | null; created_at?: string };
        Update: Partial<{ nombre: string; nit: string | null; nrc: string | null }>;
      };
      contribuyentes: {
        Row: {
          id: string; company_id: string; nombre: string; nit: string; nrc: string;
          giro: string | null; telefono: string | null; email: string | null; direccion: string | null;
          tipo: 'Cliente' | 'Proveedor' | 'Ambos'; created_at: string;
        };
        Insert: {
          id?: string; company_id: string; nombre: string; nit: string; nrc: string;
          giro?: string | null; telefono?: string | null; email?: string | null; direccion?: string | null;
          tipo: 'Cliente' | 'Proveedor' | 'Ambos'; created_at?: string;
        };
        Update: Partial<Omit<Database['public']['Tables']['contribuyentes']['Insert'], 'id' | 'company_id'>>;
      };
      ventas_consumidor: {
        Row: { id: string; company_id: string; fecha: string; descripcion: string; monto: number; notas: string | null; created_at: string };
        Insert: { id?: string; company_id: string; fecha: string; descripcion: string; monto: number; notas?: string | null; created_at?: string };
        Update: Partial<Omit<Database['public']['Tables']['ventas_consumidor']['Insert'], 'id' | 'company_id'>>;
      };
      ventas_contribuyente: {
        Row: {
          id: string; company_id: string; contribuyente_id: string | null; fecha: string;
          cliente: string; nrc: string; descripcion: string; gravado: number; exento: number;
          notas: string | null; created_at: string;
        };
        Insert: {
          id?: string; company_id: string; contribuyente_id?: string | null; fecha: string;
          cliente: string; nrc: string; descripcion: string; gravado: number; exento: number;
          notas?: string | null; created_at?: string;
        };
        Update: Partial<Omit<Database['public']['Tables']['ventas_contribuyente']['Insert'], 'id' | 'company_id'>>;
      };
      compras: {
        Row: {
          id: string; company_id: string; contribuyente_id: string | null; fecha: string;
          proveedor: string; nrc: string; descripcion: string; monto: number; iva_credito: number;
          notas: string | null; created_at: string;
        };
        Insert: {
          id?: string; company_id: string; contribuyente_id?: string | null; fecha: string;
          proveedor: string; nrc: string; descripcion: string; monto: number; iva_credito: number;
          notas?: string | null; created_at?: string;
        };
        Update: Partial<Omit<Database['public']['Tables']['compras']['Insert'], 'id' | 'company_id'>>;
      };
      csv_templates: {
        Row: { id: string; company_id: string; nombre: string; tipo: string; columnas: Json; created_at: string };
        Insert: { id?: string; company_id: string; nombre: string; tipo: string; columnas: Json; created_at?: string };
        Update: Partial<Omit<Database['public']['Tables']['csv_templates']['Insert'], 'id' | 'company_id'>>;
      };
    };
  };
}
