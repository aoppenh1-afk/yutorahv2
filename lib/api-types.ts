/** Fields consumed from YUTorah's public JSON endpoints. */
export type RawTeacher = {
  ID: number;
  title: string;
  firstName: string;
  lastName: string;
  fullName: string;
  shiurCount: number;
  isHidden: boolean;
  imageURL: string;
};
export type RawSeries = {
  ID: number;
  seriesID: number;
  name: string;
  description: string | null;
  imageURL: string;
  numShiurim: number;
  shiurCount: number;
};
export type RawTopic = {
  ID: number;
  subCategoryID?: number;
  name: string;
  categoryShortName: string;
  shiurCount: number;
};
export type RawCategory = {
  name: string;
  shortName: string;
  subCategories: RawTopic[];
};
export type RawMaterial = {
  name?: string;
  title?: string;
  materialName?: string;
  url?: string;
  fileURL?: string;
  materialURL?: string;
};
export type RawShiur = {
  shiurID?: number;
  shiurid?: number;
  shiurTitle?: string;
  shiurtitle?: string;
  shiurDescription?: string | null;
  shiurdescription?: string | null;
  shiurText?: string | null;
  shiurTeachers?: {
    teacherName: string;
    teacherID: number;
    teacherPhotoURL: string;
  }[];
  teacherfullname?: string | string[];
  teacherid?: number | number[];
  PHOTO?: string;
  photo?: string | string[];
  shiurSubcategoriesObj?: RawTopic[];
  shiurSubcategories?: number[];
  subcategoryname?: string[];
  subcategoryid?: number[];
  categoryname?: string[];
  shiurLength?: string;
  duration?: number;
  shiurDate?: string;
  shiurdate?: string;
  shiurDateSubmitted?: string | null;
  shiurdatesubmitted?: string;
  shiurSeriesName?: string | null;
  seriesname?: string[];
  shiurSeries?: number | null;
  seriesid?: number[];
  shiurLanguage?: string;
  language?: string;
  shiurMediaType?: string;
  mediatypename?: string;
  downloadURL?: string;
  shiurFileURL?: string;
  shiurdownloadurl?: string;
  shiurPlayerURL?: string;
  shiurURL?: string;
  shiurMaterials?: RawMaterial[];
  shiurvisitsnum?: number | string | null;
  shiurdownloadsnum?: number;
};
export type HomeResponse = {
  editorsPicks: RawShiur[];
  recentlyUploaded: RawShiur[];
  recentlyViewed?: RawShiur[];
  dailyShiurim: RawShiur[];
  featuredSeries: RawSeries[];
  totalShiurCount: number;
  hebrewDateString: string;
  timelyData: {
    dafStr: string;
    mishnaYomiStr: string;
    nachYomiStr: string;
    parshaStr?: string;
  };
};
export type SearchResponse = {
  response: { docs: RawShiur[]; start: number; numFound: number };
  facet_counts?: {
    facet_fields?: {
      teachers?: { TeacherId: number; TeacherName: string; Match: number }[];
      subcategories?: {
        SubcategoryId: number;
        Subcategoryname: string;
        Match: number;
      }[];
      series?: { SeriesId: number; SeriesName: string; Match: number }[];
    };
  };
};
