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
  landingPageURL?: string;
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
  middleTierName?: string | null;
  categoryName?: string | null;
  description?: string | null;
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
    teacherBio?: string | null;
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
  shiurVenue?: number | null;
  shiurVenueName?: string | null;
  location?: string | null;
  locationid?: number | number[];
  shiurPublication?: number | null;
  shiurPublicationId?: number | null;
  shiurPublicationName?: string | null;
  shiurPublicationVolumeKey?: number | null;
  shiurPublicationVolumeName?: string | null;
  publicationid?: number | number[];
  publicationname?: string | string[];
  publicationvolumeid?: number | number[];
  publicationvolumename?: string | string[];
  collectionid?: number[];
  collectionname?: string[];
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
  slideshow?: {
    id: number;
    name: string;
    description: string;
    imageURL: string;
    targetURL: string;
    urlTitle: string;
  }[];
  carousel?: {
    id: number;
    name: string | null;
    imageURL: string;
    targetURL: string;
  }[];
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
      locations?: { LocationId: number; LocationName: string; Match: number }[];
      collections?: {
        CollectionId: number;
        CollectionName: string;
        Match: number;
      }[];
      publications?: {
        PublicationId: number;
        PublicationName: string;
        Match: number;
      }[];
      publicationVolumes?: {
        PublicationVolumeId: number;
        PublicationVolume: string;
        Match: number;
      }[];
    };
  };
};
