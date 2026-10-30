import type { ClientSource, ClientStatus, ContactChannel } from '../../../shared/client-model'
import type { CaseState } from '../../../shared/case-model'

// Entirely FICTIONAL rows for the browser demo's 48-client research portfolio (#115).
// Names, handles and places are invented; contacts use only the reserved example.com
// and example.org domains. Plain tables, no randomness: sampleData.ts builds full
// records from them, so every refresh gets identical data.
//
// Client row: [displayName, source, sourceDetail, fiverrUsername, email, otherContact,
//              preferredChannel, status, createdDaysAgo, updatedDaysAgo, note]
// Clients are numbered 09..48 in table order (the eight original clients keep 01..08).
// Case row:   [clientNumber, title, goal, state, path, dueInDays, createdDaysAgo,
//              updatedDaysAgo, archived]. `path` lists the states from intake to the
//              current state; each step must be an allowed transition (case-model.ts).

export type PortfolioClientRow = readonly [
  displayName: string,
  source: ClientSource,
  sourceDetail: string | null,
  fiverrUsername: string | null,
  email: string | null,
  otherContact: string | null,
  preferredChannel: ContactChannel,
  status: ClientStatus,
  createdDaysAgo: number,
  updatedDaysAgo: number,
  note: string | null
]

export type PortfolioCaseRow = readonly [
  clientNumber: number,
  title: string,
  goal: string,
  state: CaseState,
  path: string,
  dueInDays: number | null,
  createdDaysAgo: number,
  updatedDaysAgo: number,
  archived: boolean
]

export const portfolioClients: readonly PortfolioClientRow[] = [
  ['Ixchel Barrios Mencos', 'fiverr', null, 'ixchel_tree_demo', 'ixchel.barrios@example.com', null, 'email', 'active', 95, 4, 'Asked for a tree on the mother’s side, starting in Sacatepéquez.'],
  ['Bernardo Chocoy Tum', 'referral', 'Referred by a Quetzaltenango client', null, 'bernardo.chocoy@example.com', null, 'email', 'active', 260, 6, 'Repeat client: orders one family line at a time.'],
  ['Elena Saquic Xinico', 'direct', 'Found the website from a heritage workshop flyer', null, null, 'Calls only, after 6 pm', 'other', 'active', 150, 14, null],
  ['Héctor Lam Ruiz', 'fiverr', null, 'hector_lam_demo', null, null, 'fiverr', 'active', 120, 25, null],
  ['Nadia Ortiz Mejía', 'referral', 'Friend of a Huehuetenango family now in Houston', null, 'nadia.ortiz@example.org', null, 'email', 'active', 240, 2, 'Lives in Houston; replies are quicker in the evening, Central time.'],
  ['Julio Tecú Reyes', 'other', 'Met at a fictional regional archives talk', null, 'julio.tecu@example.com', null, 'email', 'active', 180, 10, null],
  ['Aurelio Pop Chajón', 'fiverr', null, 'aurelio_pop_demo', null, null, 'fiverr', 'archived', 230, 70, 'Work finished; profile archived at the client’s request.'],
  ['Lourdes Coc Ajcalón', 'direct', 'Saw a social media post', null, 'lourdes.coc@example.com', null, 'email', 'active', 55, 8, null],
  ['Pablo Xol Tiu', 'fiverr', null, 'pablo_xol_demo', null, null, 'fiverr', 'active', 88, 35, null],
  ['Rocío Hernández Yac', 'referral', 'Referred through a community heritage event', null, 'rocio.yac@example.org', null, 'email', 'active', 70, 3, null],
  ['Esteban Cabrera Juárez', 'fiverr', null, 'esteban_cj_demo', null, null, 'fiverr', 'active', 60, 20, null],
  ['Gloria Marroquín Vides', 'direct', 'Found the website', null, null, 'Messages in Spanish only', 'other', 'active', 40, 5, null],
  ['Ramiro Tzoc Pacay', 'other', 'From a fictional school history project', null, 'ramiro.tzoc@example.com', null, 'email', 'active', 33, 2, null],
  ['Dulce María Quiroa', 'fiverr', null, 'dulce_quiroa_demo', 'dulce.quiroa@example.org', null, 'email', 'active', 300, 12, null],
  ['Mateo Ixcot Gómez', 'referral', 'Referred by Elena Saquic Xinico', null, null, null, 'unspecified', 'active', 22, 22, 'Enquired by referral; no details taken yet.'],
  ['Carmen Yolanda Batz', 'direct', 'Called the office line (fictional)', null, 'carmen.batz@example.com', null, 'email', 'active', 128, 50, null],
  ['Sebastián Ajanel Cux', 'fiverr', null, 'sebas_ajanel_demo', null, null, 'fiverr', 'active', 75, 6, null],
  ['Vanessa Estrada Lorenzana', 'other', 'Met at a fictional genealogy meetup in Toronto', null, 'vanessa.estrada@example.org', null, 'email', 'active', 19, 1, null],
  ['Óscar Tot Sipac', 'fiverr', null, 'oscar_tot_demo', null, null, 'fiverr', 'active', 210, 40, null],
  ['Lidia Pérez Gaitán', 'referral', 'Referred by a Chimaltenango family', null, null, 'Letters to the office, reply by post', 'other', 'active', 99, 19, null],
  ['Kevin Mazariegos Ruano', 'direct', 'Found the website', 'kevin_mazariegos_demo', 'kevin.mazariegos@example.com', null, 'fiverr', 'active', 14, 14, null],
  ['Verónica Chub Ixtecoc', 'referral', 'Friend of Nadia Ortiz Mejía', null, 'veronica.chub@example.com', null, 'email', 'active', 58, 9, null],
  ['Iván Choc Pop', 'fiverr', null, 'ivan_choc_demo', null, null, 'fiverr', 'archived', 290, 110, 'Archived after the second case was closed.'],
  ['Sara Esquivel Morán', 'other', 'Met at a fictional family reunion planning group', null, null, 'Chat handle kept in the office file', 'other', 'active', 31, 4, null],
  ['Pedro Ixcoy Tambriz', 'fiverr', null, 'pedro_ixcoy_demo', 'pedro.ixcoy@example.org', null, 'email', 'active', 170, 17, null],
  ['Alejandra Sis Garrido', 'direct', 'Found the website after a school talk', null, 'alejandra.sis@example.com', null, 'email', 'active', 44, 11, null],
  ['Benjamín Cifuentes Oliva', 'referral', 'Referred by a cousin living in Madrid', null, 'benjamin.cifuentes@example.com', null, 'email', 'active', 66, 26, null],
  ['Yesenia Morataya Chen', 'fiverr', null, 'yesenia_m_demo', null, null, 'fiverr', 'active', 102, 9, 'Mentioned a spring project; nothing ordered yet.'],
  ['Edgar Culajay Zúñiga', 'other', 'Mentioned in a fictional local newsletter', null, 'edgar.culajay@example.com', null, 'email', 'active', 36, 3, null],
  ['Paola Cruz Lemus', 'direct', 'Heard about the service from a neighbor in Escuintla', null, null, 'Prefers written messages', 'other', 'active', 26, 13, null],
  ['Fredy Samayoa Ramírez', 'fiverr', null, 'fredy_samayoa_demo', null, null, 'fiverr', 'active', 113, 60, null],
  ['Gabriela Mux Ortega', 'referral', 'Referred by a Jutiapa family', null, 'gabriela.mux@example.org', null, 'email', 'active', 16, 2, null],
  ['Rigoberto Tiul Sosa', 'direct', 'Found the website', null, null, null, 'unspecified', 'active', 9, 9, null],
  ['Teresa Ajxup Cahuec', 'other', 'Met at a fictional parish archive open day', null, 'teresa.ajxup@example.com', null, 'email', 'archived', 200, 95, 'Archived; the last project finished in the spring.'],
  ['Walter Ovalle Pinto', 'fiverr', null, 'walter_ovalle_demo', null, null, 'fiverr', 'active', 84, 31, null],
  ['Inés Morales Velásquez', 'referral', 'Referred by a Zacapa client', null, 'ines.morales@example.com', null, 'email', 'active', 48, 7, null],
  ['Ernesto Castañeda Lam', 'direct', 'Found the website', null, 'ernesto.castaneda@example.org', null, 'email', 'active', 12, 5, null],
  ['Miriam Gudiel Bran', 'other', 'Saw a fictional heritage exhibit poster', null, null, 'Office callback only; leave a message', 'other', 'active', 65, 15, null],
  ['Armando Rosales Tzep', 'fiverr', null, 'armando_rosales_demo', null, null, 'fiverr', 'archived', 260, 150, null],
  ['Celeste Xuya Macario', 'referral', 'Referred by a researcher in Petén', null, 'celeste.xuya@example.com', null, 'email', 'active', 8, 1, 'Newest client in the demo portfolio.']
]

export const portfolioCases: readonly PortfolioCaseRow[] = [
  // Repeat customers (2 or 3 cases each).
  [10, 'Family line — Totonicapán, 1890s', 'Find the marriage record for the great-grandparents and the names of their parents.', 'closed', 'intake>active>closed', -100, 240, 150, false],
  [10, 'Second line — Jalapa, 1920s', 'Confirm when the family arrived in the town and where the children were baptized.', 'delivered', 'intake>active>delivered', -45, 180, 40, false],
  [10, 'Third line — Zacapa, 1950s marriages', 'Locate the 1950s marriage entry and any witnesses named in it.', 'active', 'intake>active', 10, 60, 5, false],
  [11, 'Saquic family — Sololá church records', 'Trace the baptisms of three children, 1930 to 1940.', 'closed', 'intake>active>closed', -70, 140, 60, false],
  [11, 'Xinico surname origin — Chimaltenango', 'Which village does the surname first appear in, according to the local records?', 'active', 'intake>active', 1, 20, 2, false],
  [13, 'Ortiz line — Huehuetenango, 1900s', 'Confirm the birthplace of the great-grandmother and her parents’ names.', 'delivered', 'intake>active>waiting>active>delivered', -80, 230, 90, false],
  [13, 'Mejía marriage search — Quiché', 'Find the 1920s marriage under any spelling of the surname.', 'waiting', 'intake>active>waiting', -6, 120, 12, false],
  [13, 'Houston family photographs and letters', 'Review the letters and photographs the client plans to send.', 'intake', 'intake', 30, 9, 9, false],
  [14, 'Tecú family — Petén land records', 'Check whether the family appears in local land and tax lists, 1900 to 1930.', 'active', 'intake>active', 14, 170, 8, false],
  [14, 'Reyes branch — Izabal baptisms', 'Find the baptism of the eldest son.', 'closed', 'intake>closed', -50, 100, 40, false],
  [28, 'Gaitán family — Chimaltenango, 1910s', 'Establish the family group in the 1910s parish and municipal lists.', 'active', 'intake>active>waiting>active', 7, 90, 20, false],
  [28, 'Pérez siblings — spelling check', 'Decide which spelling of the surname the sibling records use.', 'closed', 'intake>active>closed', -25, 60, 30, false],

  // One case each.
  [9, 'Maternal tree — Sacatepéquez, 1950s', 'Build a tree for the mother’s side, back to the grandparents.', 'active', 'intake>active', 20, 90, 3, false],
  [12, 'Lam Ruiz — Guatemala City, 1930s', 'Find where the family lived before 1940.', 'intake', 'intake', 25, 20, 20, false],
  [15, 'Pop family — Quetzaltenango, 1900s', 'Confirm the parents of the client’s great-grandfather.', 'closed', 'intake>active>closed', -90, 200, 70, true],
  [16, 'Coc Ajcalón — Escuintla, 1880s', 'Find the earliest baptism for the family in the diocesan index.', 'active', 'intake>active', -1, 40, 1, false],
  [17, 'Xol Tiu — Alta Verapaz, 1920s', 'Locate the family in the 1920s parish registers.', 'waiting', 'intake>active>waiting', 12, 70, 15, false],
  [18, 'Yac family — San Marcos, 1940s', 'Confirm the marriage year and the bride’s hometown.', 'delivered', 'intake>active>delivered', -30, 60, 25, false],
  [19, 'Cabrera Juárez — Huehuetenango, 1850s', 'Identify the earliest family member in the local records.', 'active', 'intake>active', 2, 50, 6, false],
  [21, 'Tzoc Pacay — Jutiapa, 1960s', 'Explain a family story about a move in the 1960s.', 'intake', 'intake', null, 30, 30, false],
  [25, 'Ajanel Cux — Quiché, 1930s', 'Find the marriage record and the names of both families.', 'active', 'intake>active', 0, 60, 9, false],
  [26, 'Estrada Lorenzana — Toronto diaspora, 1970s', 'Trace the family’s departure records and the first address abroad.', 'intake', 'intake', 45, 15, 15, false],
  [27, 'Tot Sipac — Retalhuleu, 1890s', 'Find the birth year of the client’s grandfather.', 'closed', 'intake>active>closed', -90, 180, 60, false],
  [29, 'Mazariegos Ruano — San Marcos, 1920s', 'Check the spelling variants of the family name in two parishes.', 'active', 'intake>active', 30, 12, 2, false],
  [30, 'Chub Ixtecoc — Alta Verapaz, 1960s', 'Find the 1960s wedding and the witnesses listed.', 'waiting', 'intake>active>waiting', 20, 50, 9, false],
  [31, 'Choc Pop — Izabal, 1870s', 'Confirm the family’s place of origin before 1880.', 'closed', 'intake>closed', -120, 250, 110, false],
  [32, 'Esquivel Morán — Escuintla reunion history', 'Write a short family history for a reunion.', 'active', 'intake>active', 5, 25, 4, false],
  [33, 'Ixcoy Tambriz — Chiquimula, 1900s', 'Find the marriage of the great-grandparents.', 'delivered', 'intake>active>delivered', -20, 150, 17, false],
  [34, 'Sis Garrido — Jalapa, 1910s', 'Confirm the birth order of the children named in a family letter.', 'active', 'intake>active', 9, 40, 11, false],
  [35, 'Cifuentes Oliva — Madrid line, 1930s', 'Identify the family members who went to Spain.', 'active', 'intake>active', -3, 60, 26, false],
  [37, 'Culajay Zúñiga — Sololá, 1840s', 'Find the earliest record for the surname in the area.', 'intake', 'intake', 60, 30, 30, false],
  [39, 'Samayoa Ramírez — Zacapa, 1950s', 'Confirm the names of the parents and siblings.', 'active', 'intake>active', -10, 100, 40, false],
  [40, 'Mux Ortega — Jutiapa, 1880s', 'Check whether the family came from a neighboring town.', 'active', 'intake>active', 4, 14, 2, false],
  [43, 'Ovalle Pinto — Escuintla, 1900s', 'Find the family in the district lists for the period.', 'waiting', 'intake>active>waiting', 14, 70, 31, false],
  [44, 'Morales Velásquez — Zacapa, 1920s', 'Check two baptism entries against the family story.', 'closed', 'intake>active>closed', -5, 40, 7, false],
  [45, 'Castañeda Lam — Los Angeles diaspora, 1990s', 'Organize the family papers the client mentioned, dated in the 1990s.', 'intake', 'intake', 30, 10, 10, false],
  [47, 'Rosales Tzep — Petén, 1920s', 'Confirm the marriage and the children’s baptisms.', 'closed', 'intake>active>closed', -140, 220, 150, true],
  [48, 'Xuya Macario — Petén, 1950s', 'Establish the parents of the client’s grandfather.', 'intake', 'intake', 21, 7, 7, false]
]
