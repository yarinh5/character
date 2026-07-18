export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      analytics_events: {
        Row: {
          actor_user_id: string | null
          character_id: string | null
          conversation_id: string | null
          created_at: string
          event_name: string
          id: string
          metadata: Json
          operator_id: string | null
          role: Database["public"]["Enums"]["app_role"] | null
        }
        Insert: {
          actor_user_id?: string | null
          character_id?: string | null
          conversation_id?: string | null
          created_at?: string
          event_name: string
          id?: string
          metadata?: Json
          operator_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Update: {
          actor_user_id?: string | null
          character_id?: string | null
          conversation_id?: string | null
          created_at?: string
          event_name?: string
          id?: string
          metadata?: Json
          operator_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Relationships: [
          {
            foreignKeyName: "analytics_events_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_events_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      character_media_assets: {
        Row: {
          bucket_id: string
          byte_size: number | null
          character_id: string
          content_type: string
          created_at: string
          created_by_user_id: string | null
          disabled_at: string | null
          disabled_by_user_id: string | null
          disabled_reason: string | null
          display_name: string | null
          height: number | null
          id: string
          ingest_status: string
          metadata: Json
          preview_path: string | null
          sha256: string | null
          source_path: string
          status: string
          updated_at: string
          updated_by_user_id: string | null
          width: number | null
        }
        Insert: {
          bucket_id?: string
          byte_size?: number | null
          character_id: string
          content_type: string
          created_at?: string
          created_by_user_id?: string | null
          disabled_at?: string | null
          disabled_by_user_id?: string | null
          disabled_reason?: string | null
          display_name?: string | null
          height?: number | null
          id?: string
          ingest_status?: string
          metadata?: Json
          preview_path?: string | null
          sha256?: string | null
          source_path: string
          status?: string
          updated_at?: string
          updated_by_user_id?: string | null
          width?: number | null
        }
        Update: {
          bucket_id?: string
          byte_size?: number | null
          character_id?: string
          content_type?: string
          created_at?: string
          created_by_user_id?: string | null
          disabled_at?: string | null
          disabled_by_user_id?: string | null
          disabled_reason?: string | null
          display_name?: string | null
          height?: number | null
          id?: string
          ingest_status?: string
          metadata?: Json
          preview_path?: string | null
          sha256?: string | null
          source_path?: string
          status?: string
          updated_at?: string
          updated_by_user_id?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "character_media_assets_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      character_media_reservations: {
        Row: {
          conversation_id: string
          created_at: string
          ended_at: string | null
          ended_by_user_id: string | null
          ended_reason: string | null
          expires_at: string
          id: string
          media_asset_id: string
          metadata: Json
          operator_id: string
          previous_asset_status: string
          reserved_by_user_id: string
          state: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          ended_at?: string | null
          ended_by_user_id?: string | null
          ended_reason?: string | null
          expires_at: string
          id?: string
          media_asset_id: string
          metadata?: Json
          operator_id: string
          previous_asset_status: string
          reserved_by_user_id: string
          state?: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          ended_at?: string | null
          ended_by_user_id?: string | null
          ended_reason?: string | null
          expires_at?: string
          id?: string
          media_asset_id?: string
          metadata?: Json
          operator_id?: string
          previous_asset_status?: string
          reserved_by_user_id?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_media_reservations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_media_reservations_media_asset_id_fkey"
            columns: ["media_asset_id"]
            isOneToOne: false
            referencedRelation: "character_media_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_media_reservations_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      character_operator_assignments: {
        Row: {
          character_id: string
          created_at: string
          id: string
          operator_id: string
        }
        Insert: {
          character_id: string
          created_at?: string
          id?: string
          operator_id: string
        }
        Update: {
          character_id?: string
          created_at?: string
          id?: string
          operator_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "character_operator_assignments_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "character_operator_assignments_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      characters: {
        Row: {
          availability_status: Database["public"]["Enums"]["availability_status"]
          avatar_url: string | null
          category: string | null
          created_at: string
          discovery_city_id: string | null
          fictional_age: number | null
          full_description: string | null
          gallery_images: string[] | null
          id: string
          interests: string[] | null
          is_active: boolean
          is_visible: boolean
          name: string
          personality: string | null
          short_description: string | null
          updated_at: string
        }
        Insert: {
          availability_status?: Database["public"]["Enums"]["availability_status"]
          avatar_url?: string | null
          category?: string | null
          created_at?: string
          discovery_city_id?: string | null
          fictional_age?: number | null
          full_description?: string | null
          gallery_images?: string[] | null
          id?: string
          interests?: string[] | null
          is_active?: boolean
          is_visible?: boolean
          name: string
          personality?: string | null
          short_description?: string | null
          updated_at?: string
        }
        Update: {
          availability_status?: Database["public"]["Enums"]["availability_status"]
          avatar_url?: string | null
          category?: string | null
          created_at?: string
          discovery_city_id?: string | null
          fictional_age?: number | null
          full_description?: string | null
          gallery_images?: string[] | null
          id?: string
          interests?: string[] | null
          is_active?: boolean
          is_visible?: boolean
          name?: string
          personality?: string | null
          short_description?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "characters_discovery_city_id_fkey"
            columns: ["discovery_city_id"]
            isOneToOne: false
            referencedRelation: "discovery_cities"
            referencedColumns: ["id"]
          },
        ]
      }
      client_character_preferences: {
        Row: {
          character_id: string
          client_id: string
          created_at: string
          favorited_at: string | null
          is_favorite: boolean
          last_seen_at: string | null
          liked_at: string | null
          shown_count: number
          updated_at: string
        }
        Insert: {
          character_id: string
          client_id: string
          created_at?: string
          favorited_at?: string | null
          is_favorite?: boolean
          last_seen_at?: string | null
          liked_at?: string | null
          shown_count?: number
          updated_at?: string
        }
        Update: {
          character_id?: string
          client_id?: string
          created_at?: string
          favorited_at?: string | null
          is_favorite?: boolean
          last_seen_at?: string | null
          liked_at?: string | null
          shown_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_character_preferences_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      client_conversation_deletions: {
        Row: {
          client_id: string
          conversation_id: string
          deleted_at: string
        }
        Insert: {
          client_id: string
          conversation_id: string
          deleted_at?: string
        }
        Update: {
          client_id?: string
          conversation_id?: string
          deleted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_conversation_deletions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_discovery_cycle_items: {
        Row: {
          acted_at: string | null
          action: string | null
          character_id: string
          cycle_id: string
          is_recycled: boolean
          shown_at: string
        }
        Insert: {
          acted_at?: string | null
          action?: string | null
          character_id: string
          cycle_id: string
          is_recycled?: boolean
          shown_at?: string
        }
        Update: {
          acted_at?: string | null
          action?: string | null
          character_id?: string
          cycle_id?: string
          is_recycled?: boolean
          shown_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_discovery_cycle_items_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_discovery_cycle_items_cycle_id_fkey"
            columns: ["cycle_id"]
            isOneToOne: false
            referencedRelation: "client_discovery_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      client_discovery_cycles: {
        Row: {
          client_id: string
          completed_at: string | null
          cycle_number: number
          filter_hash: string
          id: string
          started_at: string
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          cycle_number: number
          filter_hash: string
          id?: string
          started_at?: string
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          cycle_number?: number
          filter_hash?: string
          id?: string
          started_at?: string
        }
        Relationships: []
      }
      client_profiles: {
        Row: {
          age: number | null
          conversation_preferences: string | null
          created_at: string
          gender: string | null
          id: string
          interests: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          age?: number | null
          conversation_preferences?: string | null
          created_at?: string
          gender?: string | null
          id?: string
          interests?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          age?: number | null
          conversation_preferences?: string | null
          created_at?: string
          gender?: string | null
          id?: string
          interests?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      conversation_locks: {
        Row: {
          conversation_id: string
          expires_at: string
          last_activity_at: string
          locked_at: string
          locked_by_operator_id: string
          locked_by_user_id: string
          metadata: Json
          release_reason: string | null
          released_at: string | null
          released_by_user_id: string | null
        }
        Insert: {
          conversation_id: string
          expires_at: string
          last_activity_at?: string
          locked_at?: string
          locked_by_operator_id: string
          locked_by_user_id: string
          metadata?: Json
          release_reason?: string | null
          released_at?: string | null
          released_by_user_id?: string | null
        }
        Update: {
          conversation_id?: string
          expires_at?: string
          last_activity_at?: string
          locked_at?: string
          locked_by_operator_id?: string
          locked_by_user_id?: string
          metadata?: Json
          release_reason?: string | null
          released_at?: string | null
          released_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_locks_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_locks_locked_by_operator_id_fkey"
            columns: ["locked_by_operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_read_states: {
        Row: {
          conversation_id: string
          last_read_at: string
          last_read_message_id: string | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          last_read_at?: string
          last_read_message_id?: string | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          last_read_at?: string
          last_read_message_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversation_read_states_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversation_read_states_last_read_message_id_fkey"
            columns: ["last_read_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          assigned_operator_id: string | null
          character_id: string
          client_hidden_at: string | null
          client_id: string
          client_unread_count: number
          created_at: string
          id: string
          last_message_at: string | null
          last_message_preview: string | null
          operator_unread_count: number
          status: Database["public"]["Enums"]["conversation_status"]
          updated_at: string
        }
        Insert: {
          assigned_operator_id?: string | null
          character_id: string
          client_hidden_at?: string | null
          client_id: string
          client_unread_count?: number
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          operator_unread_count?: number
          status?: Database["public"]["Enums"]["conversation_status"]
          updated_at?: string
        }
        Update: {
          assigned_operator_id?: string | null
          character_id?: string
          client_hidden_at?: string | null
          client_id?: string
          client_unread_count?: number
          created_at?: string
          id?: string
          last_message_at?: string | null
          last_message_preview?: string | null
          operator_unread_count?: number
          status?: Database["public"]["Enums"]["conversation_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assigned_operator_id_fkey"
            columns: ["assigned_operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_character_id_fkey"
            columns: ["character_id"]
            isOneToOne: false
            referencedRelation: "characters"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_packages: {
        Row: {
          created_at: string
          credits: number
          currency: string
          id: string
          is_active: boolean
          metadata: Json
          name: string
          price: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          credits: number
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          price: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          credits?: number
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      credit_transactions: {
        Row: {
          amount: number
          balance_after: number
          created_at: string
          created_by: string | null
          id: string
          message_id: string | null
          metadata: Json
          package_id: string | null
          reason: string | null
          type: string
          user_id: string
        }
        Insert: {
          amount: number
          balance_after: number
          created_at?: string
          created_by?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json
          package_id?: string | null
          reason?: string | null
          type: string
          user_id: string
        }
        Update: {
          amount?: number
          balance_after?: number
          created_at?: string
          created_by?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json
          package_id?: string | null
          reason?: string | null
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_transactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_transactions_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "credit_packages"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_wallets: {
        Row: {
          balance: number
          created_at: string
          lifetime_earned: number
          lifetime_spent: number
          updated_at: string
          user_id: string
        }
        Insert: {
          balance?: number
          created_at?: string
          lifetime_earned?: number
          lifetime_spent?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          balance?: number
          created_at?: string
          lifetime_earned?: number
          lifetime_spent?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      customer_info_entries: {
        Row: {
          client_id: string
          content: string
          conversation_id: string | null
          created_at: string
          created_by_user_id: string
          id: string
          metadata: Json
          operator_id: string
          updated_at: string
        }
        Insert: {
          client_id: string
          content: string
          conversation_id?: string | null
          created_at?: string
          created_by_user_id: string
          id?: string
          metadata?: Json
          operator_id: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          content?: string
          conversation_id?: string | null
          created_at?: string
          created_by_user_id?: string
          id?: string
          metadata?: Json
          operator_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_info_entries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_info_entries_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      discovery_cities: {
        Row: {
          created_at: string
          display_name_he: string
          id: string
          is_active: boolean
          slug: string
        }
        Insert: {
          created_at?: string
          display_name_he: string
          id?: string
          is_active?: boolean
          slug: string
        }
        Update: {
          created_at?: string
          display_name_he?: string
          id?: string
          is_active?: boolean
          slug?: string
        }
        Relationships: []
      }
      internal_notes: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          note: string
          operator_id: string | null
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          note: string
          operator_id?: string | null
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          note?: string
          operator_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "internal_notes_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "internal_notes_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      invites: {
        Row: {
          accepted_at: string | null
          character_ids: string[]
          created_at: string
          email: string
          expires_at: string
          full_name: string
          id: string
          invited_by: string
          status: string
          token_hash: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          character_ids?: string[]
          created_at?: string
          email: string
          expires_at?: string
          full_name: string
          id?: string
          invited_by: string
          status?: string
          token_hash: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          character_ids?: string[]
          created_at?: string
          email?: string
          expires_at?: string
          full_name?: string
          id?: string
          invited_by?: string
          status?: string
          token_hash?: string
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          content: string
          conversation_id: string
          created_at: string
          id: string
          is_read: boolean
          operator_id: string | null
          sender_id: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Insert: {
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          is_read?: boolean
          operator_id?: string | null
          sender_id?: string | null
          sender_type: Database["public"]["Enums"]["sender_type"]
        }
        Update: {
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          is_read?: boolean
          operator_id?: string | null
          sender_id?: string | null
          sender_type?: Database["public"]["Enums"]["sender_type"]
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_settings: {
        Row: {
          assignment_enabled: boolean
          created_at: string
          credits_enabled: boolean
          email_enabled: boolean
          in_app_enabled: boolean
          lock_enabled: boolean
          new_message_enabled: boolean
          new_report_enabled: boolean
          system_enabled: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          assignment_enabled?: boolean
          created_at?: string
          credits_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          lock_enabled?: boolean
          new_message_enabled?: boolean
          new_report_enabled?: boolean
          system_enabled?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          assignment_enabled?: boolean
          created_at?: string
          credits_enabled?: boolean
          email_enabled?: boolean
          in_app_enabled?: boolean
          lock_enabled?: boolean
          new_message_enabled?: boolean
          new_report_enabled?: boolean
          system_enabled?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          conversation_id: string | null
          created_at: string
          id: string
          is_read: boolean
          link: string | null
          metadata: Json
          title: string
          type: string
          user_id: string
        }
        Insert: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          link?: string | null
          metadata?: Json
          title: string
          type: string
          user_id: string
        }
        Update: {
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          id?: string
          is_read?: boolean
          link?: string | null
          metadata?: Json
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_monthly_scores: {
        Row: {
          message_count: number
          operator_id: string
          period_month: string
          points: number
          updated_at: string
        }
        Insert: {
          message_count?: number
          operator_id: string
          period_month: string
          points?: number
          updated_at?: string
        }
        Update: {
          message_count?: number
          operator_id?: string
          period_month?: string
          points?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_monthly_scores_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_score_events: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          limit_applied: number | null
          message_id: string | null
          metadata: Json
          operator_id: string
          period_month: string
          points: number
          reason: string
          streak_position: number | null
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          limit_applied?: number | null
          message_id?: string | null
          metadata?: Json
          operator_id: string
          period_month: string
          points?: number
          reason?: string
          streak_position?: number | null
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          limit_applied?: number | null
          message_id?: string | null
          metadata?: Json
          operator_id?: string
          period_month?: string
          points?: number
          reason?: string
          streak_position?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_score_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_score_events_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_score_events_operator_id_fkey"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["id"]
          },
        ]
      }
      operators: {
        Row: {
          availability_status: Database["public"]["Enums"]["availability_status"]
          created_at: string
          deleted_at: string | null
          full_name: string
          id: string
          is_active: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          availability_status?: Database["public"]["Enums"]["availability_status"]
          created_at?: string
          deleted_at?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          availability_status?: Database["public"]["Enums"]["availability_status"]
          created_at?: string
          deleted_at?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          display_name: string | null
          email: string | null
          id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          email?: string | null
          id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          conversation_id: string | null
          created_at: string
          details: string | null
          id: string
          reason: string
          reporter_id: string
          status: Database["public"]["Enums"]["report_status"]
          updated_at: string
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          details?: string | null
          id?: string
          reason: string
          reporter_id: string
          status?: Database["public"]["Enums"]["report_status"]
          updated_at?: string
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          details?: string | null
          id?: string
          reason?: string
          reporter_id?: string
          status?: Database["public"]["Enums"]["report_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reports_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          value: Json | null
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          value?: Json | null
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          value?: Json | null
        }
        Relationships: []
      }
      user_active_conversations: {
        Row: {
          conversation_id: string
          expires_at: string
          last_seen_at: string
          role: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          expires_at?: string
          last_seen_at?: string
          role: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          expires_at?: string
          last_seen_at?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_active_conversations_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      acquire_conversation_lock: {
        Args: { _conversation_id: string }
        Returns: Json
      }
      admin_adjust_client_credits: {
        Args: { _amount: number; _reason: string; _user_id: string }
        Returns: Json
      }
      cleanup_expired_conversation_locks: { Args: never; Returns: number }
      complete_character_media_upload: {
        Args: { _asset_id: string }
        Returns: Json
      }
      create_character_media_upload_intent: {
        Args: {
          _character_id: string
          _content_type: string
          _display_name?: string
        }
        Returns: Json
      }
      create_notification: {
        Args: {
          _body?: string
          _conversation_id?: string
          _dedupe_window_seconds?: number
          _link?: string
          _metadata?: Json
          _title: string
          _type: string
          _user_id: string
        }
        Returns: string
      }
      get_conversation_read_summary: {
        Args: { _conversation_id: string }
        Returns: Json
      }
      get_discovery_characters: {
        Args: { _filters?: Json }
        Returns: {
          availability_status: Database["public"]["Enums"]["availability_status"]
          avatar_url: string
          category: string
          conversation_id: string
          created_at: string
          cycle_id: string
          cycle_number: number
          fictional_age: number
          id: string
          interests: string[]
          is_favorite: boolean
          is_liked: boolean
          is_recycled: boolean
          name: string
          short_description: string
        }[]
      }
      get_my_conversation_unread_counts: {
        Args: { _conversation_ids: string[] }
        Returns: {
          conversation_id: string
          last_read_at: string
          unread_count: number
        }[]
      }
      get_my_operator_id: { Args: never; Returns: string }
      get_my_role: {
        Args: never
        Returns: Database["public"]["Enums"]["app_role"]
      }
      get_operator_media_catalog: {
        Args: { _conversation_id: string }
        Returns: {
          byte_size: number
          content_type: string
          display_name: string
          height: number
          id: string
          ingest_status: string
          is_reservable: boolean
          reservation_expires_at: string
          reservation_id: string
          status: string
          width: number
        }[]
      }
      get_sla_risk_conversations: {
        Args: { _limit?: number; _notify?: boolean }
        Returns: {
          character_avatar_url: string
          character_id: string
          character_name: string
          client_display_name: string
          client_id: string
          conversation_id: string
          last_client_message_at: string
          last_message_preview: string
          minutes_waiting: number
          status: Database["public"]["Enums"]["conversation_status"]
        }[]
      }
      grant_signup_credits: { Args: never; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      hide_conversation_for_client: {
        Args: { _conversation_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      is_conversation_client: {
        Args: { _conversation_id: string }
        Returns: boolean
      }
      is_conversation_operator: {
        Args: { _conversation_id: string }
        Returns: boolean
      }
      is_operator: { Args: never; Returns: boolean }
      is_operator_co_assigned: {
        Args: { _operator_id: string }
        Returns: boolean
      }
      leave_active_conversation: {
        Args: { _conversation_id: string }
        Returns: undefined
      }
      mark_conversation_read: {
        Args: { _as: string; _conversation_id: string }
        Returns: undefined
      }
      operator_can_access_character: {
        Args: { _character_id: string }
        Returns: boolean
      }
      release_character_media_reservation: {
        Args: { _reservation_id: string }
        Returns: Json
      }
      release_conversation_lock: {
        Args: { _conversation_id: string }
        Returns: Json
      }
      reserve_character_media_asset: {
        Args: { _asset_id: string; _conversation_id: string }
        Returns: Json
      }
      send_client_message: {
        Args: { _content: string; _conversation_id: string }
        Returns: Json
      }
      send_operator_message: {
        Args: { _content: string; _conversation_id: string }
        Returns: Json
      }
      set_character_favorite: {
        Args: { _character_id: string; _is_favorite: boolean }
        Returns: Json
      }
      set_character_swipe: {
        Args: {
          _character_id: string
          _cycle_id: string
          _filters: Json
          _swipe: string
        }
        Returns: Json
      }
      start_or_get_conversation: {
        Args: { _character_id: string }
        Returns: string
      }
      touch_active_conversation: {
        Args: { _conversation_id: string; _role: string }
        Returns: undefined
      }
      track_analytics_event: {
        Args: {
          _character_id?: string
          _conversation_id?: string
          _dedupe_seconds?: number
          _event_name: string
          _metadata?: Json
          _operator_id?: string
        }
        Returns: string
      }
    }
    Enums: {
      app_role: "client" | "operator" | "admin"
      availability_status: "available" | "busy" | "offline"
      conversation_status:
        | "open"
        | "waiting"
        | "answered"
        | "closed"
        | "reported"
      report_status: "open" | "reviewed" | "resolved" | "dismissed"
      sender_type: "client" | "operator" | "admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["client", "operator", "admin"],
      availability_status: ["available", "busy", "offline"],
      conversation_status: [
        "open",
        "waiting",
        "answered",
        "closed",
        "reported",
      ],
      report_status: ["open", "reviewed", "resolved", "dismissed"],
      sender_type: ["client", "operator", "admin"],
    },
  },
} as const
