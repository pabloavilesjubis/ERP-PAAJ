/**
 * Catálogos estandarizados del Ministerio de Hacienda de El Salvador (DGII)
 * usados en la emisión de DTEs.
 *
 *   CAT-012 — Departamentos (14)
 *   CAT-013 — Municipios (subset curado por departamento)
 *   CAT-019 — Actividades económicas (subset curado para PyMEs típicas)
 *
 * Los códigos van como STRING porque el schema del MH los exige en formato de
 * texto (con padding de ceros). Los catálogos completos de municipios y
 * actividades son extensos — empezamos con los más comunes y extendemos
 * agregando entradas conforme aparezcan casos reales.
 */

export interface CatalogItem {
  codigo: string;
  nombre: string;
}

/* ───────────────────────── CAT-012 — Departamentos ───────────────────────── */

export const DEPARTAMENTOS: CatalogItem[] = [
  { codigo: '01', nombre: 'Ahuachapán' },
  { codigo: '02', nombre: 'Santa Ana' },
  { codigo: '03', nombre: 'Sonsonate' },
  { codigo: '04', nombre: 'Chalatenango' },
  { codigo: '05', nombre: 'La Libertad' },
  { codigo: '06', nombre: 'San Salvador' },
  { codigo: '07', nombre: 'Cuscatlán' },
  { codigo: '08', nombre: 'La Paz' },
  { codigo: '09', nombre: 'Cabañas' },
  { codigo: '10', nombre: 'San Vicente' },
  { codigo: '11', nombre: 'Usulután' },
  { codigo: '12', nombre: 'San Miguel' },
  { codigo: '13', nombre: 'Morazán' },
  { codigo: '14', nombre: 'La Unión' },
];

/* ───────────────────────── CAT-013 — Municipios ────────────────────────── */
/**
 * Los códigos de municipio son únicos DENTRO del departamento (es decir,
 * (depto, municipio) es la clave compuesta). El schema del MH valida con
 * regex condicional por departamento (ej. depto 01 acepta `^0[1-9]|1[0-2]$`).
 */
export const MUNICIPIOS_POR_DEPARTAMENTO: Record<string, CatalogItem[]> = {
  // 01 — Ahuachapán (12)
  '01': [
    { codigo: '01', nombre: 'Ahuachapán' },
    { codigo: '02', nombre: 'Apaneca' },
    { codigo: '03', nombre: 'Atiquizaya' },
    { codigo: '04', nombre: 'Concepción de Ataco' },
    { codigo: '05', nombre: 'El Refugio' },
    { codigo: '06', nombre: 'Guaymango' },
    { codigo: '07', nombre: 'Jujutla' },
    { codigo: '08', nombre: 'San Francisco Menéndez' },
    { codigo: '09', nombre: 'San Lorenzo' },
    { codigo: '10', nombre: 'San Pedro Puxtla' },
    { codigo: '11', nombre: 'Tacuba' },
    { codigo: '12', nombre: 'Turín' },
  ],
  // 02 — Santa Ana (13)
  '02': [
    { codigo: '01', nombre: 'Candelaria de la Frontera' },
    { codigo: '02', nombre: 'Coatepeque' },
    { codigo: '03', nombre: 'Chalchuapa' },
    { codigo: '04', nombre: 'El Congo' },
    { codigo: '05', nombre: 'El Porvenir' },
    { codigo: '06', nombre: 'Masahuat' },
    { codigo: '07', nombre: 'Metapán' },
    { codigo: '08', nombre: 'San Antonio Pajonal' },
    { codigo: '09', nombre: 'San Sebastián Salitrillo' },
    { codigo: '10', nombre: 'Santa Ana' },
    { codigo: '11', nombre: 'Santa Rosa Guachipilín' },
    { codigo: '12', nombre: 'Santiago de la Frontera' },
    { codigo: '13', nombre: 'Texistepeque' },
  ],
  // 03 — Sonsonate (16)
  '03': [
    { codigo: '01', nombre: 'Acajutla' },
    { codigo: '02', nombre: 'Armenia' },
    { codigo: '03', nombre: 'Caluco' },
    { codigo: '04', nombre: 'Cuisnahuat' },
    { codigo: '05', nombre: 'Izalco' },
    { codigo: '06', nombre: 'Juayúa' },
    { codigo: '07', nombre: 'Nahuizalco' },
    { codigo: '08', nombre: 'Nahulingo' },
    { codigo: '09', nombre: 'Salcoatitán' },
    { codigo: '10', nombre: 'San Antonio del Monte' },
    { codigo: '11', nombre: 'San Julián' },
    { codigo: '12', nombre: 'Santa Catarina Masahuat' },
    { codigo: '13', nombre: 'Santa Isabel Ishuatán' },
    { codigo: '14', nombre: 'Santo Domingo de Guzmán' },
    { codigo: '15', nombre: 'Sonsonate' },
    { codigo: '16', nombre: 'Sonzacate' },
  ],
  // 04 — Chalatenango (33) — los más comunes
  '04': [
    { codigo: '01', nombre: 'Agua Caliente' },
    { codigo: '02', nombre: 'Arcatao' },
    { codigo: '04', nombre: 'Chalatenango' },
    { codigo: '14', nombre: 'La Palma' },
    { codigo: '15', nombre: 'Las Flores' },
    { codigo: '17', nombre: 'Nueva Concepción' },
    { codigo: '20', nombre: 'San Francisco Lempa' },
    { codigo: '24', nombre: 'San Ignacio' },
    { codigo: '28', nombre: 'Tejutla' },
  ],
  // 05 — La Libertad (22) — todos
  '05': [
    { codigo: '01', nombre: 'Antiguo Cuscatlán' },
    { codigo: '02', nombre: 'Chiltiupán' },
    { codigo: '03', nombre: 'Ciudad Arce' },
    { codigo: '04', nombre: 'Colón' },
    { codigo: '05', nombre: 'Comasagua' },
    { codigo: '06', nombre: 'Huizúcar' },
    { codigo: '07', nombre: 'Jayaque' },
    { codigo: '08', nombre: 'Jicalapa' },
    { codigo: '09', nombre: 'La Libertad' },
    { codigo: '10', nombre: 'Santa Tecla' },
    { codigo: '11', nombre: 'Nuevo Cuscatlán' },
    { codigo: '12', nombre: 'San Juan Opico' },
    { codigo: '13', nombre: 'Quezaltepeque' },
    { codigo: '14', nombre: 'Sacacoyo' },
    { codigo: '15', nombre: 'San José Villanueva' },
    { codigo: '16', nombre: 'San Matías' },
    { codigo: '17', nombre: 'San Pablo Tacachico' },
    { codigo: '18', nombre: 'Talnique' },
    { codigo: '19', nombre: 'Tamanique' },
    { codigo: '20', nombre: 'Teotepeque' },
    { codigo: '21', nombre: 'Tepecoyo' },
    { codigo: '22', nombre: 'Zaragoza' },
  ],
  // 06 — San Salvador (19) — todos
  '06': [
    { codigo: '01', nombre: 'Aguilares' },
    { codigo: '02', nombre: 'Apopa' },
    { codigo: '03', nombre: 'Ayutuxtepeque' },
    { codigo: '04', nombre: 'Cuscatancingo' },
    { codigo: '05', nombre: 'Ciudad Delgado' },
    { codigo: '06', nombre: 'El Paisnal' },
    { codigo: '07', nombre: 'Guazapa' },
    { codigo: '08', nombre: 'Ilopango' },
    { codigo: '09', nombre: 'Mejicanos' },
    { codigo: '10', nombre: 'Nejapa' },
    { codigo: '11', nombre: 'Panchimalco' },
    { codigo: '12', nombre: 'Rosario de Mora' },
    { codigo: '13', nombre: 'San Marcos' },
    { codigo: '14', nombre: 'San Salvador' },
    { codigo: '15', nombre: 'Santiago Texacuangos' },
    { codigo: '16', nombre: 'Santo Tomás' },
    { codigo: '17', nombre: 'Soyapango' },
    { codigo: '18', nombre: 'Tonacatepeque' },
    { codigo: '19', nombre: 'San Martín' },
  ],
  // 07 — Cuscatlán (16)
  '07': [
    { codigo: '01', nombre: 'Candelaria' },
    { codigo: '02', nombre: 'Cojutepeque' },
    { codigo: '03', nombre: 'El Carmen' },
    { codigo: '04', nombre: 'El Rosario' },
    { codigo: '05', nombre: 'Monte San Juan' },
    { codigo: '06', nombre: 'Oratorio de Concepción' },
    { codigo: '07', nombre: 'San Bartolomé Perulapía' },
    { codigo: '08', nombre: 'San Cristóbal' },
    { codigo: '09', nombre: 'San José Guayabal' },
    { codigo: '10', nombre: 'San Pedro Perulapán' },
    { codigo: '11', nombre: 'San Rafael Cedros' },
    { codigo: '12', nombre: 'San Ramón' },
    { codigo: '13', nombre: 'Santa Cruz Analquito' },
    { codigo: '14', nombre: 'Santa Cruz Michapa' },
    { codigo: '15', nombre: 'Suchitoto' },
    { codigo: '16', nombre: 'Tenancingo' },
  ],
  // 08 — La Paz (22)
  '08': [
    { codigo: '01', nombre: 'Cuyultitán' },
    { codigo: '02', nombre: 'El Rosario' },
    { codigo: '03', nombre: 'Jerusalén' },
    { codigo: '04', nombre: 'Mercedes La Ceiba' },
    { codigo: '05', nombre: 'Olocuilta' },
    { codigo: '06', nombre: 'Paraíso de Osorio' },
    { codigo: '07', nombre: 'San Antonio Masahuat' },
    { codigo: '08', nombre: 'San Emigdio' },
    { codigo: '09', nombre: 'San Francisco Chinameca' },
    { codigo: '10', nombre: 'San Pedro Masahuat' },
    { codigo: '11', nombre: 'San Pedro Nonualco' },
    { codigo: '12', nombre: 'San Juan Nonualco' },
    { codigo: '13', nombre: 'San Juan Talpa' },
    { codigo: '14', nombre: 'San Juan Tepezontes' },
    { codigo: '15', nombre: 'San Luis La Herradura' },
    { codigo: '16', nombre: 'San Luis Talpa' },
    { codigo: '17', nombre: 'San Miguel Tepezontes' },
    { codigo: '18', nombre: 'San Rafael Obrajuelo' },
    { codigo: '19', nombre: 'Santa María Ostuma' },
    { codigo: '20', nombre: 'Santiago Nonualco' },
    { codigo: '21', nombre: 'Tapalhuaca' },
    { codigo: '22', nombre: 'Zacatecoluca' },
  ],
  // 09 — Cabañas (9)
  '09': [
    { codigo: '01', nombre: 'Cinquera' },
    { codigo: '02', nombre: 'Dolores' },
    { codigo: '03', nombre: 'Guacotecti' },
    { codigo: '04', nombre: 'Ilobasco' },
    { codigo: '05', nombre: 'Jutiapa' },
    { codigo: '06', nombre: 'San Isidro' },
    { codigo: '07', nombre: 'Sensuntepeque' },
    { codigo: '08', nombre: 'Tejutepeque' },
    { codigo: '09', nombre: 'Victoria' },
  ],
  // 10 — San Vicente (13)
  '10': [
    { codigo: '01', nombre: 'Apastepeque' },
    { codigo: '02', nombre: 'Guadalupe' },
    { codigo: '03', nombre: 'San Cayetano Istepeque' },
    { codigo: '04', nombre: 'San Esteban Catarina' },
    { codigo: '05', nombre: 'San Ildefonso' },
    { codigo: '06', nombre: 'San Lorenzo' },
    { codigo: '07', nombre: 'San Sebastián' },
    { codigo: '08', nombre: 'San Vicente' },
    { codigo: '09', nombre: 'Santa Clara' },
    { codigo: '10', nombre: 'Santo Domingo' },
    { codigo: '11', nombre: 'Tecoluca' },
    { codigo: '12', nombre: 'Tepetitán' },
    { codigo: '13', nombre: 'Verapaz' },
  ],
  // 11 — Usulután (23)
  '11': [
    { codigo: '01', nombre: 'Alegría' },
    { codigo: '02', nombre: 'Berlín' },
    { codigo: '03', nombre: 'California' },
    { codigo: '04', nombre: 'Concepción Batres' },
    { codigo: '05', nombre: 'El Triunfo' },
    { codigo: '06', nombre: 'Ereguayquín' },
    { codigo: '07', nombre: 'Estanzuelas' },
    { codigo: '08', nombre: 'Jiquilisco' },
    { codigo: '09', nombre: 'Jucuapa' },
    { codigo: '10', nombre: 'Jucuarán' },
    { codigo: '11', nombre: 'Mercedes Umaña' },
    { codigo: '12', nombre: 'Nueva Granada' },
    { codigo: '13', nombre: 'Ozatlán' },
    { codigo: '14', nombre: 'Puerto El Triunfo' },
    { codigo: '15', nombre: 'San Agustín' },
    { codigo: '16', nombre: 'San Buenaventura' },
    { codigo: '17', nombre: 'San Dionisio' },
    { codigo: '18', nombre: 'San Francisco Javier' },
    { codigo: '19', nombre: 'Santa Elena' },
    { codigo: '20', nombre: 'Santa María' },
    { codigo: '21', nombre: 'Santiago de María' },
    { codigo: '22', nombre: 'Tecapán' },
    { codigo: '23', nombre: 'Usulután' },
  ],
  // 12 — San Miguel (20)
  '12': [
    { codigo: '01', nombre: 'Carolina' },
    { codigo: '02', nombre: 'Chapeltique' },
    { codigo: '03', nombre: 'Chinameca' },
    { codigo: '04', nombre: 'Chirilagua' },
    { codigo: '05', nombre: 'Ciudad Barrios' },
    { codigo: '06', nombre: 'Comacarán' },
    { codigo: '07', nombre: 'El Tránsito' },
    { codigo: '08', nombre: 'Lolotique' },
    { codigo: '09', nombre: 'Moncagua' },
    { codigo: '10', nombre: 'Nueva Guadalupe' },
    { codigo: '11', nombre: 'Nuevo Edén de San Juan' },
    { codigo: '12', nombre: 'Quelepa' },
    { codigo: '13', nombre: 'San Antonio del Mosco' },
    { codigo: '14', nombre: 'San Gerardo' },
    { codigo: '15', nombre: 'San Jorge' },
    { codigo: '16', nombre: 'San Luis de la Reina' },
    { codigo: '17', nombre: 'San Miguel' },
    { codigo: '18', nombre: 'San Rafael Oriente' },
    { codigo: '19', nombre: 'Sesori' },
    { codigo: '20', nombre: 'Uluazapa' },
  ],
  // 13 — Morazán (26) — los más comunes
  '13': [
    { codigo: '01', nombre: 'Arambala' },
    { codigo: '07', nombre: 'Corinto' },
    { codigo: '11', nombre: 'Jocoaitique' },
    { codigo: '14', nombre: 'Lolotiquillo' },
    { codigo: '20', nombre: 'San Francisco Gotera' },
    { codigo: '23', nombre: 'Sociedad' },
  ],
  // 14 — La Unión (18)
  '14': [
    { codigo: '01', nombre: 'Anamorós' },
    { codigo: '02', nombre: 'Bolívar' },
    { codigo: '03', nombre: 'Concepción de Oriente' },
    { codigo: '04', nombre: 'Conchagua' },
    { codigo: '05', nombre: 'El Carmen' },
    { codigo: '06', nombre: 'El Sauce' },
    { codigo: '07', nombre: 'Intipucá' },
    { codigo: '08', nombre: 'La Unión' },
    { codigo: '09', nombre: 'Lislique' },
    { codigo: '10', nombre: 'Meanguera del Golfo' },
    { codigo: '11', nombre: 'Nueva Esparta' },
    { codigo: '12', nombre: 'Pasaquina' },
    { codigo: '13', nombre: 'Polorós' },
    { codigo: '14', nombre: 'San Alejo' },
    { codigo: '15', nombre: 'San José' },
    { codigo: '16', nombre: 'Santa Rosa de Lima' },
    { codigo: '17', nombre: 'Yayantique' },
    { codigo: '18', nombre: 'Yucuaiquín' },
  ],
};

/* ───────────────────────── CAT-019 — Actividades económicas ───────────────────────── */
/**
 * Subset curado de actividades económicas estandarizadas (CIIU rev. 4) —
 * las más comunes para PyMEs salvadoreñas. La opción "Otra" permite ingresar
 * un código personalizado si la actividad específica no está aquí.
 */
export const ACTIVIDADES_ECONOMICAS: CatalogItem[] = [
  // Comercio al por mayor y por menor
  { codigo: '46900', nombre: 'Comercio al por mayor no especializado' },
  { codigo: '47111', nombre: 'Venta al por menor en establecimientos no especializados (supermercado, abarrotería)' },
  { codigo: '47190', nombre: 'Otras ventas al por menor en establecimientos no especializados' },
  { codigo: '47211', nombre: 'Venta al por menor de productos alimenticios en tienda especializada' },
  { codigo: '47220', nombre: 'Venta al por menor de carnes y productos cárnicos' },
  { codigo: '47230', nombre: 'Venta al por menor de pescado, mariscos' },
  { codigo: '47241', nombre: 'Venta al por menor de pan, productos de panadería y repostería' },
  { codigo: '47300', nombre: 'Venta al por menor de combustibles' },
  { codigo: '47410', nombre: 'Venta al por menor de equipos de informática y comunicaciones' },
  { codigo: '47521', nombre: 'Venta al por menor de materiales de construcción y ferretería' },
  { codigo: '47711', nombre: 'Venta al por menor de prendas de vestir' },
  { codigo: '47721', nombre: 'Venta al por menor de calzado y artículos de cuero' },
  { codigo: '47730', nombre: 'Venta al por menor de productos farmacéuticos (farmacia)' },
  { codigo: '47740', nombre: 'Venta al por menor de artículos médicos y ortopédicos' },
  { codigo: '47750', nombre: 'Venta al por menor de cosméticos y artículos de tocador' },

  // Reparación y mantenimiento de vehículos
  { codigo: '45200', nombre: 'Mantenimiento y reparación de vehículos automotores' },
  { codigo: '45301', nombre: 'Venta de partes, piezas y accesorios de vehículos automotores' },

  // Restaurantes y servicios de comida
  { codigo: '56101', nombre: 'Restaurantes y servicios móviles de comida' },
  { codigo: '56210', nombre: 'Suministro de comidas por encargo (catering)' },
  { codigo: '56301', nombre: 'Cafetería' },

  // Servicios profesionales
  { codigo: '69100', nombre: 'Actividades jurídicas (abogados, notarios)' },
  { codigo: '69200', nombre: 'Actividades de contabilidad, teneduría de libros y auditoría' },
  { codigo: '70210', nombre: 'Actividades de consultoría en relaciones públicas y comunicaciones' },
  { codigo: '70220', nombre: 'Otras actividades de consultoría empresarial' },
  { codigo: '71101', nombre: 'Actividades de arquitectura' },
  { codigo: '71102', nombre: 'Actividades de ingeniería' },
  { codigo: '71200', nombre: 'Ensayos y análisis técnicos' },
  { codigo: '73100', nombre: 'Publicidad' },
  { codigo: '74100', nombre: 'Actividades especializadas de diseño' },
  { codigo: '74200', nombre: 'Actividades de fotografía' },

  // Tecnología
  { codigo: '62010', nombre: 'Actividades de programación informática' },
  { codigo: '62020', nombre: 'Actividades de consultoría informática' },
  { codigo: '63110', nombre: 'Procesamiento de datos, hosting y actividades conexas' },
  { codigo: '63120', nombre: 'Portales web' },

  // Construcción
  { codigo: '41001', nombre: 'Construcción de edificios residenciales' },
  { codigo: '41002', nombre: 'Construcción de edificios no residenciales' },
  { codigo: '42100', nombre: 'Construcción de carreteras y vías de ferrocarril' },
  { codigo: '43210', nombre: 'Instalaciones eléctricas' },
  { codigo: '43220', nombre: 'Instalaciones de fontanería, calefacción y aire acondicionado' },
  { codigo: '43300', nombre: 'Acabado de edificios' },

  // Salud
  { codigo: '86100', nombre: 'Actividades de hospitales' },
  { codigo: '86201', nombre: 'Consultorios médicos' },
  { codigo: '86202', nombre: 'Actividades odontológicas' },
  { codigo: '86901', nombre: 'Actividades de laboratorios médicos' },

  // Educación
  { codigo: '85100', nombre: 'Educación preprimaria y primaria' },
  { codigo: '85200', nombre: 'Educación secundaria' },
  { codigo: '85410', nombre: 'Educación superior' },
  { codigo: '85530', nombre: 'Enseñanza de idiomas' },

  // Otros servicios
  { codigo: '81210', nombre: 'Limpieza general de edificios' },
  { codigo: '95110', nombre: 'Reparación de computadoras y equipos periféricos' },
  { codigo: '95210', nombre: 'Reparación de aparatos electrónicos de consumo' },
  { codigo: '96021', nombre: 'Salones de belleza y peluquerías' },
  { codigo: '96030', nombre: 'Pompas fúnebres y actividades conexas' },

  // Transporte y logística
  { codigo: '49323', nombre: 'Servicio de transporte por taxi' },
  { codigo: '52102', nombre: 'Almacenamiento y depósito' },
  { codigo: '53200', nombre: 'Mensajería y otras actividades postales' },

  // Hospedaje
  { codigo: '55101', nombre: 'Hoteles' },
  { codigo: '55103', nombre: 'Hostales y casas de huéspedes' },

  // Inmobiliaria
  { codigo: '68100', nombre: 'Actividades inmobiliarias con bienes propios o arrendados' },
  { codigo: '68200', nombre: 'Actividades inmobiliarias por contrato o comisión' },

  // Alquileres
  { codigo: '77110', nombre: 'Alquiler de vehículos automotores' },
  { codigo: '77210', nombre: 'Alquiler de equipo recreativo y deportivo' },
];

/* ───────────────────────── Helpers ───────────────────────── */

export function findActividad(codigo: string): CatalogItem | undefined {
  return ACTIVIDADES_ECONOMICAS.find(a => a.codigo === codigo);
}

export function findMunicipio(deptCodigo: string, muniCodigo: string): CatalogItem | undefined {
  const munis = MUNICIPIOS_POR_DEPARTAMENTO[deptCodigo];
  return munis?.find(m => m.codigo === muniCodigo);
}

export function findDepartamento(codigo: string): CatalogItem | undefined {
  return DEPARTAMENTOS.find(d => d.codigo === codigo);
}

export function getMunicipiosFor(deptCodigo: string): CatalogItem[] {
  return MUNICIPIOS_POR_DEPARTAMENTO[deptCodigo] ?? [];
}
